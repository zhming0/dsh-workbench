#!/usr/bin/env node

import { randomBytes } from "node:crypto";

import { DockerBackend } from "../provider/dist/backends/docker.js";
import { TunnelServer } from "../provider/dist/tunnel.js";

const image = process.env.DSH_RUNNER_IMAGE ?? "dsh-runner:dev";
const workspace = "/workspace/repository";
const registrationToken = randomBytes(32).toString("hex");
const tunnel = new TunnelServer({
  port: 0,
  tokens: [registrationToken],
  log: (message) => process.stdout.write(`${message}\n`),
});
await tunnel.listen();
const backend = new DockerBackend({
  image,
  hostUrl: `tcp://host.docker.internal:${tunnel.port()}`,
  registrationToken,
});
let handle;

try {
  handle = await backend.provision({
    sessionId: `smoke-${Date.now()}`,
    repositoryUrl: "https://github.com/example/unused.git",
  });

  let client = await waitForRunner(tunnel, handle.sandboxId);
  await client.setSecrets({ SMOKE_VALUE: "present" });
  await run(client, [
    "/bin/bash",
    "-lc",
    'test "$SMOKE_VALUE" = present && git --version && jj --version && mise --version',
  ]);

  await run(client, ["mkdir", "-p", `${workspace}/.git`, `${workspace}/.dsh`]);
  await client.writeFile({
    path: `${workspace}/.dsh/setup.sh`,
    content: new TextEncoder().encode(
      `#!/bin/sh\nset -eu\nprintf 'workspace survived' > ${workspace}/sentinel\n`,
    ),
    guard: { case: "createIfAbsent", value: true },
  });
  await run(client, ["chmod", "+x", `${workspace}/.dsh/setup.sh`]);
  const firstSetup = await client.setup({
    repositoryUrl: "https://github.com/example/unused.git",
    revision: "",
    workspace,
  });
  if (!firstSetup.ran) throw new Error("first setup did not run");

  // Hibernation kills the tunnel socket; on wake the runner dials back in.
  await backend.hibernate(handle.reference);
  tunnel.drop(handle.sandboxId);
  handle = await backend.wake(handle.reference);
  client = await waitForRunner(tunnel, handle.sandboxId);
  const secondSetup = await client.setup({
    repositoryUrl: "https://github.com/example/unused.git",
    revision: "",
    workspace,
  });
  if (secondSetup.ran) throw new Error("setup marker did not survive hibernation");
  const sentinel = await client.readFile({
    path: `${workspace}/sentinel`,
    maxBytes: 1024n,
  });
  if (new TextDecoder().decode(sentinel.content) !== "workspace survived") {
    throw new Error("workspace content did not survive hibernation");
  }

  process.stdout.write("PASS: Docker runner registration, tools, setup, and hibernate/wake\n");
} finally {
  if (handle !== undefined) await backend.destroy(handle.reference).catch(() => {});
  await tunnel.close();
}

async function waitForRunner(tunnel, sandboxId) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const client = await tunnel.waitFor(sandboxId, deadline - Date.now());
      const health = await client.health({ timeoutMs: 2_000 });
      if (health.sandboxId !== sandboxId) {
        throw new Error(`runner identity mismatch: got ${health.sandboxId}`);
      }
      return client;
    } catch (error) {
      lastError = error;
      tunnel.drop(sandboxId);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`runner did not become ready: ${String(lastError)}`);
}

async function run(client, argv) {
  let stderr = "";
  let exited = false;
  for await (const response of client.exec({
    argv,
    cwd: "/workspace",
    env: {},
    stdin: new Uint8Array(),
  })) {
    if (response.event.case === "stdout") process.stdout.write(response.event.value);
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
}
