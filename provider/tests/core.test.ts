import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { Context } from "@deepseek-ai/cordis";
import { agentEvents, type Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { CustomObjectsApi } from "@kubernetes/client-node";
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
import { RunnerService } from "../src/gen/dsh/sandbox/v1/runner_pb.js";
import { SandboxManager } from "../src/index.js";
import type { RunnerClient } from "../src/runner-client.js";
import { pathInSandbox } from "../src/sandbox-path.js";
import { testing as shellTesting } from "../src/shell.js";
import { SessionStore } from "../src/state-store.js";
import { testing as subprocessTesting } from "../src/subprocess.js";
import { TunnelServer, type RunnerGateway } from "../src/tunnel.js";
import type {
  BackendReference,
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

  it("admits one runner per sandbox through the tunnel handshake", async () => {
    const tunnel = new TunnelServer({ port: 0, tokens: ["good-token"] });
    await tunnel.listen();
    const h2 = http2.createServer(
      connectNodeAdapter({
        routes: (router) =>
          router.service(RunnerService, {
            health: () => ({ sandboxId: "sandbox-one", setupComplete: true }),
          }),
      }),
    );
    try {
      const port = tunnel.port();
      expect(await handshake(port, "sandbox-one", "bad-token")).toEqual({
        ok: false,
        error: "invalid registration token",
      });

      // An accepted runner serves HTTP/2 over the socket it dialed with.
      const { socket, reply } = await openTunnel(
        port,
        "sandbox-one",
        "good-token",
      );
      expect(reply).toEqual({ ok: true });
      h2.emit("connection", socket);
      const client = await tunnel.waitFor("sandbox-one", 5_000);
      const health = await client.health({ timeoutMs: 5_000 });
      expect(health.sandboxId).toBe("sandbox-one");

      // While that registration lives, a second one for the same sandbox is
      // refused; this blocks in-sandbox impersonation of another session.
      expect(await handshake(port, "sandbox-one", "good-token")).toEqual({
        ok: false,
        error: "sandbox is already registered",
      });

      // Dropping the registration lets the runner register again.
      tunnel.drop("sandbox-one");
      const again = await openTunnel(port, "sandbox-one", "good-token");
      expect(again.reply).toEqual({ ok: true });
      again.socket.destroy();

      // A dead socket frees its registration without an explicit drop, so a
      // runner redialing after a broken tunnel is not rejected as a
      // duplicate.
      await expect
        .poll(() => handshake(port, "sandbox-one", "good-token"), {
          timeout: 5_000,
        })
        .toEqual({ ok: true });
    } finally {
      await tunnel.close();
      h2.close();
    }
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

  it("serves a GITHUB_TOKEN secret as the github.com git credential", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();

    // No GITHUB_TOKEN secret: no credential.
    expect(
      await broker.gitCredentials("https://github.com/example/repo.git"),
    ).toEqual([]);

    await broker.setSecret("GITHUB_TOKEN", "pat-value");
    expect(
      await broker.gitCredentials("https://github.com/example/repo.git"),
    ).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "pat-value",
      },
    ]);

    // Only github.com is mapped.
    expect(
      await broker.gitCredentials("https://gitlab.com/example/repo.git"),
    ).toEqual([]);
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
    });

    expect(result).toEqual({
      sandboxId: "sandbox-one",
      reference: { claimName: "claim-one", sandboxId: "sandbox-one" },
    });
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

  it("provisions a Kubernetes sandbox once its claim is assigned", async () => {
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
    });

    expect(result).toEqual({
      sandboxId: "sandbox-one",
      reference: {
        claimName: kasTesting.claimNameFor("session-one"),
        sandboxId: "sandbox-one",
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
    const backend = new DockerBackend({
      image: "runner:test",
      binary: docker,
      hostUrl: "tcp://host.docker.internal:8081",
      registrationToken: "token-value",
    });

    const handle = await backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
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
    expect(commands[0]).toContain("HOST_URL=tcp://host.docker.internal:8081");
    expect(commands[0]).toContain("REGISTRATION_TOKEN=token-value");
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
      { backend, gateway: gatewayFor(backend) },
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
      { backend, gateway: gatewayFor(backend), workspaceRegistry },
    );
    const anchor = await manager.createRepositoryWorkspace(
      "https://github.com/example/public.git",
    );
    await manager.setGlobalInstructions("Use concise answers.");
    await manager.setWorkspaceInstructions(
      "https://github.com/example/public.git",
      "Run the repository tests.",
    );
    const agent = {
      id: "session-one",
      session: {
        header: { cwd: anchor },
        events: [],
        surface: { nodes: [] },
      },
    } as unknown as Agent;

    await manager.ensureRunning(agent);

    const emptyDecision = await agentEvents(ctx, agent).waterfall(
      "agent/pre-step",
      {
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: "enter", messages: [] }),
    );
    const prompt = createUserMessage({
      content: [{ type: "text", text: "What instructions apply?" }],
      source: { kind: "user" },
    });
    const decision = await agentEvents(ctx, agent).waterfall(
      "agent/pre-step",
      {
        messages: [prompt],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: "enter", messages: [prompt] }),
    );

    expect(workspaceRegistry.creates).toEqual([
      { path: anchor, title: "example/public" },
    ]);
    expect(backend.repositoryUrls).toEqual([
      "https://github.com/example/public",
    ]);
    expect(emptyDecision).toEqual({ kind: "enter", messages: [] });
    expect(await manager.getInstructions()).toEqual({
      global: "Use concise answers.",
      workspaces: [
        {
          repositoryUrl: "https://github.com/example/public",
          title: "example/public",
          content: "Run the repository tests.",
        },
      ],
    });
    expect(decision).toMatchObject({
      kind: "enter",
      messages: [
        prompt,
        {
          content: [
            {
              type: "text",
              text: expect.stringMatching(
                /Use concise answers[\s\S]*Run the repository tests/,
              ),
            },
          ],
          source: {
            kind: "plugin",
            plugin: "@zhming0/dsh-workbench:instructions",
            form: "instructions",
          },
        },
      ],
    });
    await expect(
      manager.setWorkspaceInstructions(
        "https://github.com/example/unknown",
        "Do not save this.",
      ),
    ).rejects.toThrow("not registered");
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
      (() => {
        const backend = new FakeBackend();
        return { backend, gateway: gatewayFor(backend) };
      })(),
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

  list() {
    return this.creates.map(({ path, title }) => ({
      path,
      title: title ?? path,
    }));
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
}

/** Stands in for the tunnel: every wait resolves to the fake runner. */
function gatewayFor(backend: FakeBackend): RunnerGateway {
  return {
    waitFor: async () => backend.client as unknown as RunnerClient,
    drop() {},
  };
}

function openTunnel(
  port: number,
  sandboxId: string,
  token: string,
): Promise<{ socket: Socket; reply: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      socket.write(`${JSON.stringify({ sandboxId, token })}\n`);
    });
    socket.once("error", reject);
    socket.once("data", (chunk) => {
      // Anything past the reply line is the host's eager HTTP/2 preface;
      // pause and leave it buffered for whoever attaches an HTTP/2 server.
      socket.pause();
      const newline = chunk.indexOf(0x0a);
      const rest = chunk.subarray(newline + 1);
      if (rest.length > 0) socket.unshift(rest);
      resolve({
        socket,
        reply: JSON.parse(chunk.subarray(0, newline).toString("utf8")),
      });
    });
  });
}

async function handshake(
  port: number,
  sandboxId: string,
  token: string,
): Promise<unknown> {
  const { socket, reply } = await openTunnel(port, sandboxId, token);
  socket.destroy();
  return reply;
}
