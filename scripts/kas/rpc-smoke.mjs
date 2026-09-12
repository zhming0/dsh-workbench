#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const namespace = process.env.KAS_NAMESPACE ?? "dsh-sandbox";
const warmPool = process.env.KAS_WARM_POOL ?? "dsh-universal";
const registrationToken = requiredEnvironment("REGISTRATION_TOKEN");
const profile = process.env.DSH_PROFILE_DIR ?? "/opt/dsh-host/profile";
const require = createRequire(join(profile, "package.json"));
const workbenchRoot = dirname(
  require.resolve("@zhming0/dsh-workbench/package.json"),
);
const { KasBackend } = await import(
  pathToFileURL(join(workbenchRoot, "dist/backends/kas.js")).href
);
const { TunnelServer } = await import(
  pathToFileURL(join(workbenchRoot, "dist/tunnel.js")).href
);
const { CustomObjectsApi, KubeConfig } = await import(
  pathToFileURL(require.resolve("@kubernetes/client-node")).href
);

const tunnel = new TunnelServer({
  port: 8081,
  bind: "0.0.0.0",
  tokens: [registrationToken],
  log: (message) => process.stdout.write(`${message}\n`),
});
const backend = new KasBackend({
  namespace,
  warmPool,
  readyTimeoutMs: 180_000,
});
const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const kubernetes = kubeConfig.makeApiClient(CustomObjectsApi);
const workspace = "/workspace";
const sentinelPath = `${workspace}/.dsh-kas-rpc-smoke`;
let handle;
let success = false;

try {
  await tunnel.listen();
  const warmSandboxId = await waitForWarmSandbox(kubernetes);
  // Kubernetes readiness only covers the runner's local health endpoint. Do
  // not claim the warm Sandbox until its production tunnel is ready too.
  await waitForRunner(tunnel, warmSandboxId);
  handle = await backend.provision({
    sessionId: `kas-rpc-smoke-${Date.now()}`,
    repositoryUrl: "https://github.com/example/unused.git",
  });
  assertEqual(handle.sandboxId, warmSandboxId, "claimed warm Sandbox");

  let client = await waitForRunner(tunnel, handle.sandboxId);
  await client.setSecrets({ KAS_RPC_SMOKE: "present" });
  const first = await run(client, [
    "/bin/bash",
    "-lc",
    'test "$KAS_RPC_SMOKE" = present && printf connected && printf diagnostic >&2',
  ]);
  assertEqual(first.stdout, "connected", "initial command output");
  assertEqual(first.stderr, "diagnostic", "initial command error output");

  // The runner forwards the template's DOCKER_HOST to commands, and the
  // rootless daemon sidecar answers on that socket.
  const dockerHost = await run(client, ["/bin/bash", "-lc", 'printf %s "$DOCKER_HOST"']);
  assertEqual(
    dockerHost.stdout,
    "unix:///run/user/1000/docker.sock",
    "DOCKER_HOST in a runner command",
  );
  const docker = await run(client, ["docker", "version", "--format", "{{.Server.Os}}"]);
  assertEqual(docker.stdout.trim(), "linux", "Docker daemon reachable from a runner command");

  await client.writeFile({
    path: sentinelPath,
    content: new TextEncoder().encode("workspace survived"),
    guard: { case: "overwrite", value: true },
  });
  const home = (await run(client, ["sh", "-c", 'printf %s "$HOME"'])).stdout;
  assertEqual(home, "/workspace/home", "home directory");
  await client.writeFile({
    path: `${home}/home-sentinel`,
    content: new TextEncoder().encode("home survived"),
    guard: { case: "overwrite", value: true },
  });

  // Suspension removes the pod and its socket. Wake recreates the pod, whose
  // runner must dial back in while retaining the workspace volume.
  await backend.hibernate(handle.reference);
  tunnel.drop(handle.sandboxId);
  handle = await backend.wake(handle.reference);
  client = await waitForRunner(tunnel, handle.sandboxId);
  const awake = await run(client, ["printf", "awake"]);
  assertEqual(awake.stdout, "awake", "command output after wake");
  const sentinel = await client.readFile({
    path: sentinelPath,
    maxBytes: 1024n,
  });
  assertEqual(
    new TextDecoder().decode(sentinel.content),
    "workspace survived",
    "workspace content after wake",
  );
  const homeSentinel = await client.readFile({
    path: `${home}/home-sentinel`,
    maxBytes: 1024n,
  });
  assertEqual(
    new TextDecoder().decode(homeSentinel.content),
    "home survived",
    "home content after wake",
  );

  success = true;
  process.stdout.write(
    "PASS: Kubernetes runner registration, RPC, reconnect, and hibernate/wake\n",
  );
} finally {
  // Keep a failed claim and runner alive until the outer test captures logs.
  if (success && handle !== undefined)
    await backend.destroy(handle.reference).catch(() => {});
  await tunnel.close();
}

async function waitForWarmSandbox(api) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await api.listNamespacedCustomObject({
      group: "agents.x-k8s.io",
      version: "v1beta1",
      namespace,
      plural: "sandboxes",
      labelSelector: "agents.x-k8s.io/warm-pool-sandbox",
    });
    // The claim controller adopts a candidate only after it has observed the
    // backing Pod's IP, and cold-starts the claim when no candidate reports one
    // within a two-second grace period. Wait for the state adoption needs.
    const warm = response.items?.find((item) => item.status?.podIPs?.length > 0);
    const sandboxId = warm?.metadata?.name;
    if (typeof sandboxId === "string" && sandboxId !== "") return sandboxId;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("warm Sandbox did not appear within 120000ms");
}

async function waitForRunner(tunnelServer, sandboxId) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const client = await tunnelServer.waitFor(
        sandboxId,
        Math.max(deadline - Date.now(), 1),
      );
      const health = await client.health({ timeoutMs: 5_000 });
      if (health.sandboxId !== sandboxId) {
        throw new Error(
          `runner identity mismatch: expected ${sandboxId}, got ${health.sandboxId}`,
        );
      }
      return client;
    } catch (error) {
      lastError = error;
      tunnelServer.drop(sandboxId);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`runner did not become healthy: ${String(lastError)}`);
}

async function run(client, argv) {
  let stdout = "";
  let stderr = "";
  let exited = false;
  for await (const response of client.exec({
    argv,
    cwd: workspace,
    env: {},
    stdin: new Uint8Array(),
  })) {
    if (response.event.case === "stdout") {
      stdout += new TextDecoder().decode(response.event.value);
    }
    if (response.event.case === "stderr") {
      stderr += new TextDecoder().decode(response.event.value);
    }
    if (response.event.case === "exited") {
      exited = true;
      if (
        response.event.value.exitCode !== 0 ||
        response.event.value.signal !== ""
      ) {
        const status =
          response.event.value.signal === ""
            ? `exit ${response.event.value.exitCode}`
            : `signal ${response.event.value.signal}`;
        throw new Error(`command failed with ${status}: ${stderr}`);
      }
    }
  }
  if (!exited) throw new Error("command stream ended without an exit status");
  return { stdout, stderr };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertEqual(actual, expected, subject) {
  if (actual !== expected) {
    throw new Error(`${subject}: expected ${expected}, got ${actual}`);
  }
}
