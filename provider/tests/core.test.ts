import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CustomObjectsApi } from "@kubernetes/client-node";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DockerBackend,
  testing as dockerTesting,
} from "../src/backends/docker.js";
import { KasBackend, testing as kasTesting } from "../src/backends/kas.js";
import {
  CredentialBroker,
  normalizeRepositoryUrl,
  testing as brokerTesting,
} from "../src/broker.js";
import { SandboxManager } from "../src/index.js";
import { ProviderKeyStore } from "../src/key-store.js";
import type { RunnerClient } from "../src/runner-client.js";
import { pathInSandbox } from "../src/sandbox-path.js";
import { testing as shellTesting } from "../src/shell.js";
import { SessionStore } from "../src/state-store.js";
import { testing as subprocessTesting } from "../src/subprocess.js";
import type {
  BackendReference,
  RunnerAuth,
  SandboxBackend,
  SandboxSpec,
} from "../src/types.js";
import {
  createRepositoryAnchor,
  normalizeWorkspaceRepositoryUrl,
  repositoryForAnchor,
  repositoryTitle,
} from "../src/workspace-anchor.js";

describe("provider building blocks", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("creates a short-lived token for one sandbox identity", async () => {
    const keys = new ProviderKeyStore(join(directory, "provider-key.pem"));
    await keys.initialize();
    const token = await keys.createToken("sandbox-one");
    expect(decodeJwt(token).sandbox_id).toBe("sandbox-one");
    expect(keys.publicKeyPem).toContain("PUBLIC KEY");
    expect(
      await readFile(join(directory, "provider-key.pem"), "utf8"),
    ).toContain("PRIVATE KEY");
  });

  it("persists session records atomically", async () => {
    const path = join(directory, "sessions.json");
    const store = new SessionStore(path);
    await store.initialize();
    await store.set({
      sessionId: "one",
      backend: "fake",
      sandboxId: "sandbox-one",
      reference: { id: "one" },
      repositoryUrl: "https://github.com/example/repo.git",
      state: "running",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const reopened = new SessionStore(path);
    await reopened.initialize();
    expect(reopened.get("one")?.sandboxId).toBe("sandbox-one");
  });

  it("stores secret names without exposing values in listings", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret("API_KEY", "secret-value");
    expect(broker.secretNames()).toEqual(["API_KEY"]);
    expect(broker.secrets()).toEqual({ API_KEY: "secret-value" });
    await expect(broker.setSecret("not-valid-name", "x")).rejects.toThrow(
      "invalid",
    );
  });

  it("parses repository hosts and stable backend names", () => {
    expect(
      brokerTesting.repositoryHost("git@github.com:example/repo.git"),
    ).toBe("github.com");
    expect(
      brokerTesting.repositoryHost("https://gitlab.com/example/repo.git"),
    ).toBe("gitlab.com");
    expect(normalizeRepositoryUrl("git@github.com:example/repo.git")).toBe(
      "https://github.com/example/repo.git",
    );
    expect(
      normalizeWorkspaceRepositoryUrl(" git@github.com:example/repo.git "),
    ).toBe("https://github.com/example/repo");
    expect(
      normalizeWorkspaceRepositoryUrl("git@gitlab.com:example/repo.git"),
    ).toBe("git@gitlab.com:example/repo");
    expect(repositoryTitle("https://github.com/example/repo")).toBe(
      "example/repo",
    );
    expect(() =>
      normalizeWorkspaceRepositoryUrl("https://user:secret@example.com/repo"),
    ).toThrow("password");
    expect(() =>
      normalizeWorkspaceRepositoryUrl("https://token@example.com/repo"),
    ).toThrow("credentials");
    expect(() =>
      normalizeWorkspaceRepositoryUrl(
        "git@example.com:owner/repo?token=secret",
      ),
    ).toThrow("query or fragment");
    expect(() =>
      normalizeWorkspaceRepositoryUrl("file:///home/user/repo"),
    ).toThrow("HTTP, HTTPS, SSH, or Git");
    expect(dockerTesting.sandboxName("session one")).toMatch(
      /^dsh-[a-f0-9]{16}$/,
    );
    expect(kasTesting.claimNameFor("session one")).toMatch(
      /^dsh-[a-f0-9]{20}$/,
    );
    expect(
      dockerTesting.parseInspect(
        JSON.stringify([
          {
            Id: "container-one",
            Config: { Labels: { "dsh.session": "session one" } },
            State: { Status: "exited" },
          },
        ]),
      ),
    ).toEqual({
      containerId: "container-one",
      sessionId: "session one",
      status: "exited",
    });
  });

  it("can retry a Kubernetes wake after expiry was already cleared", async () => {
    const patches: Array<{ plural: string; body: unknown }> = [];
    const api = {
      async getNamespacedCustomObject(request: { plural: string }) {
        return request.plural === "sandboxclaims"
          ? {
              spec: {},
              status: { sandbox: { name: "sandbox-one" } },
            }
          : {
              status: {
                serviceFQDN: "sandbox-one.example.internal",
                conditions: [{ type: "Ready", status: "True" }],
              },
            };
      },
      async patchNamespacedCustomObject(request: {
        plural: string;
        body: unknown;
      }) {
        patches.push(request);
        return {};
      },
    } as unknown as CustomObjectsApi;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test" },
      api,
    );

    const result = await backend.wake({
      claimName: "claim-one",
      sandboxId: "sandbox-one",
      serviceFqdn: "old.example.internal",
    });

    expect(result.reference.serviceFqdn).toBe("sandbox-one.example.internal");
    expect(patches).toEqual([
      {
        group: "agents.x-k8s.io",
        version: "v1beta1",
        namespace: "test",
        plural: "sandboxes",
        name: "sandbox-one",
        body: [{ op: "add", path: "/spec/operatingMode", value: "Running" }],
      },
    ]);
  });

  it("reads a Kubernetes runner endpoint from the assigned Sandbox", async () => {
    const reads: string[] = [];
    const api = {
      async createNamespacedCustomObject() {
        return {};
      },
      async getNamespacedCustomObject(request: { plural: string }) {
        reads.push(request.plural);
        return request.plural === "sandboxclaims"
          ? {
              status: {
                sandbox: { name: "sandbox-one" },
                conditions: [{ type: "Ready", status: "True" }],
              },
            }
          : {
              status: {
                serviceFQDN: "sandbox-one.example.internal",
                conditions: [{ type: "Ready", status: "True" }],
              },
            };
      },
    } as unknown as CustomObjectsApi;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test" },
      api,
    );

    const result = await backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
      publicKeyPem: "public key",
    });

    expect(result).toEqual({
      sandboxId: "sandbox-one",
      reference: {
        claimName: kasTesting.claimNameFor("session-one"),
        sandboxId: "sandbox-one",
        serviceFqdn: "sandbox-one.example.internal",
      },
    });
    expect(reads).toEqual(["sandboxclaims", "sandboxes"]);
  });

  it("recovers a Docker container created before its session was saved", async () => {
    const commandLog = join(directory, "docker-commands.jsonl");
    const docker = join(directory, "fake-docker.mjs");
    await writeFile(
      docker,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "run") process.exit(1);
if (args[0] === "inspect") process.stdout.write(JSON.stringify([{
  Id: "existing-container",
  Config: { Labels: { "dsh.session": "session-one" } },
  State: { Status: "exited" }
}]));
`,
      { mode: 0o700 },
    );
    const backend = new DockerBackend({ image: "runner:test", binary: docker });

    const handle = await backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
      publicKeyPem: "test public key",
    });

    expect(handle).toEqual({
      sandboxId: dockerTesting.sandboxName("session-one"),
      reference: {
        containerId: "existing-container",
        sandboxId: dockerTesting.sandboxName("session-one"),
      },
    });
    const commands = (await readFile(commandLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands.map(([command]) => command)).toEqual([
      "run",
      "inspect",
      "start",
    ]);
    expect(commands[2]).toEqual(["start", "existing-container"]);
  });

  it("keeps bounded output tails and reports loss", () => {
    const shell = new shellTesting.TailBuffer(4);
    shell.append(new TextEncoder().encode("abcdef"));
    expect(shell.collected()).toEqual({ text: "cdef", truncated: true });

    const subprocess = new subprocessTesting.CollectedBuffer(4);
    subprocess.append(new TextEncoder().encode("abcdef"));
    expect(subprocess.readFrom(0)).toEqual({
      text: "cdef",
      nextOffset: 6,
      lossy: true,
    });
  });

  it("maps dsh workspace paths into the sandbox workspace", () => {
    const sessionWorkspace = "/home/user/project";
    const sandboxWorkspace = "/workspace/repository";

    expect(
      pathInSandbox(sessionWorkspace, sessionWorkspace, sandboxWorkspace),
    ).toBe("/workspace/repository");
    expect(
      pathInSandbox(
        "/home/user/project/packages/api",
        sessionWorkspace,
        sandboxWorkspace,
      ),
    ).toBe("/workspace/repository/packages/api");
    expect(
      pathInSandbox(
        "/workspace/repository/packages/web",
        sessionWorkspace,
        sandboxWorkspace,
      ),
    ).toBe("/workspace/repository/packages/web");
    expect(
      pathInSandbox(
        "/home/user/another-project",
        sessionWorkspace,
        sandboxWorkspace,
      ),
    ).toBe("/home/user/another-project");
    expect(
      pathInSandbox(
        "/home/user/project/../outside",
        sessionWorkspace,
        sandboxWorkspace,
      ),
    ).toBe("/home/user/project/../outside");
    expect(
      pathInSandbox("packages/worker", sessionWorkspace, sandboxWorkspace),
    ).toBe("packages/worker");
  });

  it("provisions, hibernates, and wakes one sandbox per session", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backend },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    expect(manager.workspace).toBe("/workspace/repository");
    await manager.ensureRunning(agent);
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);
    expect(backend.client.setups).toBe(1);
    expect(backend.expiries).toBe(0);

    const cliBroker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await cliBroker.initialize();
    await cliBroker.setSecret("UPDATED_IN_CLI", "available-on-next-command");
    await manager.ensureRunning(agent);
    expect(backend.client.secrets).toEqual({
      UPDATED_IN_CLI: "available-on-next-command",
    });

    backend.running = false;
    backend.client.healthy = false;
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);
    expect(backend.wakes).toBe(1);

    await manager.hibernate("session-one");
    expect(backend.expiries).toBe(1);
    await manager.ensureRunning(agent);
    expect(backend.hibernations).toBe(1);
    expect(backend.wakes).toBe(2);
    expect(backend.client.setups).toBe(3);
  });

  it("creates one durable host anchor per repository", async () => {
    const [first, second] = await Promise.all([
      createRepositoryAnchor(
        directory,
        "https://github.com/example/public.git",
      ),
      createRepositoryAnchor(directory, "https://github.com/example/public"),
    ]);
    const different = await createRepositoryAnchor(
      directory,
      "https://github.com/example/other",
    );

    expect(second).toEqual(first);
    expect(different.path).not.toBe(first.path);
    expect(first.title).toBe("example/public");
    expect(await repositoryForAnchor(directory, first.path)).toBe(
      "https://github.com/example/public",
    );
    expect(await repositoryForAnchor(directory, directory)).toBeUndefined();
    expect((await stat(first.path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(first.path, "repository.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("registers a repository anchor before a Web session is created", async () => {
    const backend = new FakeBackend();
    const workspaceRegistry = new FakeWorkspaceRegistry();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        stateDir: directory,
        repository: "https://github.com/example/fallback.git",
      },
      { backend, workspaceRegistry },
    );
    const anchor = await manager.createRepositoryWorkspace(
      "https://github.com/example/public.git",
    );
    const agent = {
      id: "session-one",
      session: { header: { cwd: anchor } },
    } as unknown as Agent;

    await manager.ensureRunning(agent);

    expect(workspaceRegistry.creates).toEqual([
      { path: anchor, title: "example/public" },
    ]);
    expect(backend.repositoryUrls).toEqual([
      "https://github.com/example/public",
    ]);
    expect(
      (
        ctx.get("directoryPicker") as { capability(): { kind: string } }
      ).capability().kind,
    ).toBe("repository");
  });

  it("does not create repository anchors without the Web workspace service", async () => {
    const manager = new SandboxManager(
      new Context(),
      {
        stateDir: directory,
        repository: "https://github.com/example/fallback",
      },
      { backend: new FakeBackend() },
    );
    await manager.ensureRunning({
      id: "headless-session",
      session: { header: {} },
    } as unknown as Agent);

    await expect(
      manager.createRepositoryWorkspace("https://github.com/example/public"),
    ).rejects.toThrow("Web profile");
    await expect(stat(join(directory, "workspace-anchors"))).rejects.toThrow();
  });
});

class FakeWorkspaceRegistry {
  readonly creates: Array<{ path: string; title?: string }> = [];

  async create(path: string, title?: string) {
    this.creates.push(title === undefined ? { path } : { path, title });
    return { path };
  }
}

class FakeRunnerClient {
  setups = 0;
  healthy = true;
  secrets: Record<string, string> = {};

  async health() {
    if (!this.healthy) throw new Error("runner is unavailable");
    return { sandboxId: "sandbox-one", setupComplete: this.setups > 0 };
  }

  async setSecrets(secrets: Record<string, string>) {
    this.secrets = secrets;
  }
  async setGitCredentials() {}

  async setup() {
    this.setups += 1;
    return { ran: this.setups === 1 };
  }
}

class FakeBackend implements SandboxBackend {
  readonly name = "fake";
  readonly capabilities = { supportsHibernate: true };
  readonly client = new FakeRunnerClient();
  provisions = 0;
  hibernations = 0;
  wakes = 0;
  expiries = 0;
  running = false;
  readonly repositoryUrls: string[] = [];

  async provision(spec: SandboxSpec) {
    this.provisions += 1;
    this.repositoryUrls.push(spec.repositoryUrl);
    this.running = true;
    return { sandboxId: "sandbox-one", reference: { id: "one" } };
  }

  async hibernate() {
    this.hibernations += 1;
    this.running = false;
  }

  async wake(reference: BackendReference) {
    this.wakes += 1;
    this.running = true;
    this.client.healthy = true;
    return { sandboxId: "sandbox-one", reference };
  }

  async destroy() {
    this.running = false;
  }

  async expireAt() {
    this.expiries += 1;
  }

  async health() {
    return this.running;
  }

  async connect(_reference: BackendReference, _auth: RunnerAuth) {
    return this.client as unknown as RunnerClient;
  }
}
