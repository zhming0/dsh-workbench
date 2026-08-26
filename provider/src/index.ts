import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Service, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { metrics, trace } from "@opentelemetry/api";

import { DockerBackend } from "./backends/docker.js";
import { KasBackend } from "./backends/kas.js";
import { CredentialBroker, normalizeRepositoryUrl } from "./broker.js";
import { ProviderKeyStore } from "./key-store.js";
import type { RunnerClient } from "./runner-client.js";
import { SessionStore } from "./state-store.js";
import { SandboxNotFoundError } from "./types.js";
import type {
  AuthChallenge,
  ChallengeHandler,
  SandboxBackend,
  SessionRecord,
} from "./types.js";

const execute = promisify(execFile);
const tracer = trace.getTracer("dsh-sandbox-provider");
const meter = metrics.getMeter("dsh-sandbox-provider");
const claimLatency = meter.createHistogram("dsh.sandbox.claim.duration", {
  unit: "ms",
});
const resumeLatency = meter.createHistogram("dsh.sandbox.resume.duration", {
  unit: "ms",
});
const transitions = meter.createCounter("dsh.sandbox.lifecycle.transitions");

export interface Config {
  backend?: "docker" | "kas";
  stateDir?: string;
  repository?: string;
  revision?: string;
  workspace?: string;
  idleMs?: number;
  expiresAfterMs?: number;
  githubClientId?: string;
  wipCommit?: boolean;
  docker?: {
    image?: string;
    binary?: string;
  };
  kas?: {
    namespace?: string;
    warmPool?: string;
    runnerPort?: number;
    readyTimeoutMs?: number;
    kubeconfig?: string;
  };
}

interface ResolvedConfig {
  backend: "docker" | "kas";
  stateDir: string;
  repository?: string;
  revision: string;
  workspace: string;
  idleMs: number;
  expiresAfterMs: number;
  githubClientId?: string;
  wipCommit: boolean;
  docker: { image: string; binary?: string };
  kas: {
    namespace: string;
    warmPool: string;
    runnerPort: number;
    readyTimeoutMs: number;
    kubeconfig?: string;
  };
}

export interface ManagerDependencies {
  backend?: SandboxBackend;
  store?: SessionStore;
  broker?: CredentialBroker;
  keys?: ProviderKeyStore;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sandboxManager: SandboxManager;
  }
}

/** Owns one durable sandbox record per dsh session. */
export class SandboxManager extends Service {
  static inject = ["agents"];
  static Config = z.object({
    backend: z.union([z.const("docker"), z.const("kas")]).default("docker"),
    stateDir: z.string(),
    repository: z.string(),
    revision: z.string().default(""),
    workspace: z.string().default("/workspace"),
    idleMs: z
      .number()
      .min(1)
      .default(10 * 60_000),
    expiresAfterMs: z
      .number()
      .min(1)
      .default(7 * 24 * 60 * 60_000),
    githubClientId: z.string(),
    wipCommit: z.boolean().default(false),
    docker: z.object({
      image: z.string().default("dsh-runner:dev"),
      binary: z.string(),
    }),
    kas: z.object({
      namespace: z.string().default("dsh-sandbox"),
      warmPool: z.string().default("dsh-universal"),
      runnerPort: z.natural().min(1).max(65_535).default(8080),
      readyTimeoutMs: z.number().min(1).default(180_000),
      kubeconfig: z.string(),
    }),
  });

  readonly workspace: string;
  private readonly config: ResolvedConfig;
  private readonly backend: SandboxBackend;
  private readonly store: SessionStore;
  private readonly broker: CredentialBroker;
  private readonly keys: ProviderKeyStore;
  private readonly ready: Promise<void>;
  private readonly operations = new Map<string, Promise<void>>();
  private readonly clients = new Map<string, RunnerClient>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly activity = new Map<string, number>();

  constructor(
    ctx: Context,
    config: Config = {},
    dependencies: ManagerDependencies = {},
  ) {
    super(ctx, "sandboxManager");
    this.config = resolveConfig(config);
    this.workspace = this.config.workspace;
    this.keys =
      dependencies.keys ??
      new ProviderKeyStore(join(this.config.stateDir, "provider-key.pem"));
    this.store =
      dependencies.store ??
      new SessionStore(join(this.config.stateDir, "sessions.json"));
    this.broker =
      dependencies.broker ??
      new CredentialBroker({
        path: join(this.config.stateDir, "broker.json"),
        ...(this.config.githubClientId === undefined
          ? {}
          : { githubClientId: this.config.githubClientId }),
      });
    this.backend = dependencies.backend ?? createBackend(this.config);
    this.ready = this.initialize();

    ctx.on("agent/session-start", ({ agent }) =>
      this.ensureRunning(agent, (challenge) =>
        injectChallenge(agent, challenge),
      ),
    );
    ctx.on("agent/pre-step", async ({ agent }, next) => {
      await this.ensureRunning(agent, (challenge) =>
        injectChallenge(agent, challenge),
      );
      return next();
    });
    ctx.on("agent/status", ({ agent, status }) => {
      if (status === "running") this.markActive(String(agent.id));
    });
    ctx.on("session/event", (session, event) => {
      if (event.type === "turn/end") this.scheduleIdle(session);
    });
    ctx.effect(() => () => {
      for (const timer of this.idleTimers.values()) clearTimeout(timer);
      this.idleTimers.clear();
    });
  }

  /** Resolve the current foreground agent and return its live runner. */
  clientForCurrentAgent(): Promise<RunnerClient> {
    return this.ensureRunning(this.ctx.agents.requireInitiator());
  }

  async ensureRunning(
    agent: Agent,
    challenge?: ChallengeHandler,
  ): Promise<RunnerClient> {
    await this.ready;
    const sessionId = String(agent.id);
    this.markActive(sessionId);
    return this.serialize(sessionId, () =>
      tracer.startActiveSpan("sandbox.ensure-running", async (span) => {
        try {
          return await this.ensureRunningUnlocked(agent, challenge);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: 2, message: String(error) });
          throw error;
        } finally {
          span.end();
        }
      }),
    );
  }

  async hibernate(sessionId: string): Promise<void> {
    await this.ready;
    await this.serialize(sessionId, () => this.hibernateUnlocked(sessionId));
  }

  private async hibernateUnlocked(sessionId: string): Promise<void> {
    const record = this.store.get(sessionId);
    if (record === undefined || record.state === "hibernated") return;

    if (this.config.wipCommit) await this.commitWorkInProgress(sessionId);
    const deadline = new Date(Date.now() + this.config.expiresAfterMs);
    try {
      if (this.backend.capabilities.supportsHibernate) {
        await this.backend.hibernate(record.reference);
        // Set the final deletion time after compute is suspended. If the
        // provider stops between these steps, the still-running local record
        // will recover and wake the same sandbox instead of leaving an active
        // sandbox with a hidden expiry.
        await this.backend.expireAt(record.reference, deadline);
        await this.store.set({
          ...record,
          state: "hibernated",
          expiresAt: deadline.toISOString(),
          updatedAt: new Date().toISOString(),
        });
        transitions.add(1, {
          backend: this.backend.name,
          transition: "hibernate",
        });
      } else {
        await this.backend.destroy(record.reference);
        await this.store.delete(sessionId);
        transitions.add(1, {
          backend: this.backend.name,
          transition: "expire",
        });
      }
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
      await this.store.delete(sessionId);
      transitions.add(1, { backend: this.backend.name, transition: "missing" });
    }
    this.clients.delete(sessionId);
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      this.keys.initialize(),
      this.store.initialize(),
      this.broker.initialize(),
    ]);
    for (const record of this.store.values()) {
      if (record.state === "running") {
        this.scheduleIdle(record.sessionId);
        continue;
      }
      const deadline =
        record.expiresAt === undefined ? undefined : new Date(record.expiresAt);
      if (
        deadline === undefined ||
        !Number.isFinite(deadline.getTime()) ||
        deadline.getTime() <= Date.now()
      ) {
        await this.backend.destroy(record.reference);
        await this.store.delete(record.sessionId);
        continue;
      }
      try {
        await this.backend.expireAt(record.reference, deadline);
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
        // A missing backend object means its external garbage collection won.
        // Remove the stale local record so the next turn provisions cleanly.
        await this.store.delete(record.sessionId);
      }
    }
  }

  private async ensureRunningUnlocked(
    agent: Agent,
    challenge?: ChallengeHandler,
  ): Promise<RunnerClient> {
    const sessionId = String(agent.id);
    let record = this.store.get(sessionId);
    if (
      record?.expiresAt !== undefined &&
      new Date(record.expiresAt).getTime() <= Date.now()
    ) {
      await this.backend.destroy(record.reference);
      await this.store.delete(sessionId);
      record = undefined;
    }

    const cached = this.clients.get(sessionId);
    if (cached !== undefined && record?.state === "running") {
      try {
        const health = await cached.health({ timeoutMs: 5_000 });
        if (health.sandboxId !== record.sandboxId)
          throw new Error("runner identity changed");
        await this.broker.refresh();
        const credentials = await this.broker.gitCredentials(
          record.repositoryUrl,
          challenge,
        );
        await cached.setSecrets(this.broker.secrets());
        await cached.setGitCredentials(credentials);
        return cached;
      } catch {
        this.clients.delete(sessionId);
      }
    }

    const runningSandboxNeedsRecovery =
      record?.state === "running" &&
      !(await this.backend.health(record.reference));

    const repositoryUrl =
      record?.repositoryUrl ??
      normalizeRepositoryUrl(await this.repositoryFor(agent));
    await this.broker.refresh();
    const credentials = await this.broker.gitCredentials(
      repositoryUrl,
      challenge,
    );

    if (
      record !== undefined &&
      (record.state === "hibernated" || runningSandboxNeedsRecovery)
    ) {
      try {
        const started = Date.now();
        const handle = await this.backend.wake(record.reference);
        resumeLatency.record(Date.now() - started, {
          backend: this.backend.name,
        });
        const { expiresAt: _expiredDeadline, ...durableRecord } = record;
        record = {
          ...durableRecord,
          sandboxId: handle.sandboxId,
          reference: handle.reference,
          state: "running",
          updatedAt: new Date().toISOString(),
        };
        await this.store.set(record);
        transitions.add(1, { backend: this.backend.name, transition: "wake" });
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
        await this.backend.destroy(record.reference).catch(() => {});
        await this.store.delete(sessionId);
        record = undefined;
      }
    }

    if (record === undefined) {
      const started = Date.now();
      const handle = await this.backend.provision({
        sessionId,
        repositoryUrl,
        publicKeyPem: this.keys.publicKeyPem,
      });
      claimLatency.record(Date.now() - started, { backend: this.backend.name });
      record = {
        sessionId,
        backend: this.backend.name,
        sandboxId: handle.sandboxId,
        reference: handle.reference,
        repositoryUrl,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
      await this.store.set(record);
      transitions.add(1, {
        backend: this.backend.name,
        transition: "provision",
      });
    }

    const client = await this.waitForRunner(record);
    await client.setSecrets(this.broker.secrets());
    await client.setGitCredentials(credentials);
    await client.setup({
      repositoryUrl,
      revision: this.config.revision,
      workspace: this.config.workspace,
    });
    this.clients.set(sessionId, client);
    return client;
  }

  private async waitForRunner(record: SessionRecord): Promise<RunnerClient> {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const client = await this.backend.connect(record.reference, this.keys);
        const health = await client.health({ timeoutMs: 5_000 });
        if (health.sandboxId !== record.sandboxId) {
          throw new Error(
            `runner identity mismatch: expected ${record.sandboxId}, got ${health.sandboxId}`,
          );
        }
        return client;
      } catch (error) {
        lastError = error;
        await delay(500);
      }
    }
    throw new Error(`runner did not become healthy: ${String(lastError)}`);
  }

  private async repositoryFor(agent: Agent): Promise<string> {
    if (this.config.repository !== undefined) return this.config.repository;
    const cwd = agent.session.header.cwd;
    if (cwd === undefined) {
      throw new Error(
        "sandbox repository is not configured and the dsh session has no cwd",
      );
    }
    try {
      const { stdout } = await execute("git", [
        "-C",
        cwd,
        "remote",
        "get-url",
        "origin",
      ]);
      const repository = stdout.trim();
      if (repository.length === 0) throw new Error("origin is empty");
      return repository;
    } catch (error) {
      throw new Error(
        `cannot resolve a repository from ${cwd}; configure repository explicitly`,
        {
          cause: error,
        },
      );
    }
  }

  private scheduleIdle(session: Session | string): void {
    const sessionId =
      typeof session === "string" ? session : String(session.id);
    this.cancelIdle(sessionId);
    const activity = this.activity.get(sessionId) ?? 0;
    const timer = setTimeout(
      () =>
        void this.hibernateIfInactive(sessionId, activity).catch(() => {
          if ((this.activity.get(sessionId) ?? 0) === activity) {
            this.scheduleIdle(sessionId);
          }
        }),
      this.config.idleMs,
    );
    timer.unref();
    this.idleTimers.set(sessionId, timer);
  }

  private async hibernateIfInactive(
    sessionId: string,
    expectedActivity: number,
  ): Promise<void> {
    await this.ready;
    await this.serialize(sessionId, async () => {
      if ((this.activity.get(sessionId) ?? 0) !== expectedActivity) return;
      await this.hibernateUnlocked(sessionId);
    });
  }

  private markActive(sessionId: string): void {
    this.cancelIdle(sessionId);
    this.activity.set(sessionId, (this.activity.get(sessionId) ?? 0) + 1);
  }

  private cancelIdle(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.idleTimers.delete(sessionId);
  }

  private serialize<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.operations.set(sessionId, tail);
    void tail.finally(() => {
      if (this.operations.get(sessionId) === tail)
        this.operations.delete(sessionId);
    });
    return result;
  }

  private async commitWorkInProgress(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (client === undefined) return;
    const stream = client.exec({
      argv: [
        "/bin/bash",
        "-lc",
        'git add -A && (git diff --cached --quiet || git commit -m "dsh: save work before hibernation")',
      ],
      cwd: this.config.workspace,
      env: {},
      stdin: new Uint8Array(),
    });
    for await (const event of stream) {
      if (event.event.case === "exited" && event.event.value.exitCode !== 0) {
        throw new Error(
          "could not save a work-in-progress commit before hibernation",
        );
      }
    }
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const stateDir = config.stateDir ?? join(homedir(), ".dsh-sandbox");
  const resolved: ResolvedConfig = {
    backend: config.backend ?? "docker",
    stateDir,
    ...(config.repository === undefined
      ? {}
      : { repository: config.repository }),
    revision: config.revision ?? "",
    workspace: config.workspace ?? "/workspace",
    idleMs: config.idleMs ?? 10 * 60_000,
    expiresAfterMs: config.expiresAfterMs ?? 7 * 24 * 60 * 60_000,
    ...(config.githubClientId === undefined
      ? {}
      : { githubClientId: config.githubClientId }),
    wipCommit: config.wipCommit ?? false,
    docker: {
      image: config.docker?.image ?? "dsh-runner:dev",
      ...(config.docker?.binary === undefined
        ? {}
        : { binary: config.docker.binary }),
    },
    kas: {
      namespace: config.kas?.namespace ?? "dsh-sandbox",
      warmPool: config.kas?.warmPool ?? "dsh-universal",
      runnerPort: config.kas?.runnerPort ?? 8080,
      readyTimeoutMs: config.kas?.readyTimeoutMs ?? 180_000,
      ...(config.kas?.kubeconfig === undefined
        ? {}
        : { kubeconfig: config.kas.kubeconfig }),
    },
  };
  for (const [name, value] of [
    ["idleMs", resolved.idleMs],
    ["expiresAfterMs", resolved.expiresAfterMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be positive`);
  }
  if (!resolved.workspace.startsWith("/"))
    throw new Error("workspace must be an absolute Linux path");
  return resolved;
}

function createBackend(config: ResolvedConfig): SandboxBackend {
  return config.backend === "docker"
    ? new DockerBackend(config.docker)
    : new KasBackend(config.kas);
}

function injectChallenge(agent: Agent, challenge: AuthChallenge): void {
  agent.inject(
    createUserMessage({
      content: [
        {
          type: "text",
          text: `GitHub authorization is needed. Visit ${challenge.verificationUri} and enter ${challenge.userCode}.`,
        },
      ],
      source: { kind: "plugin", plugin: "dsh-sandbox" },
    }),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { DockerBackend } from "./backends/docker.js";
export { KasBackend } from "./backends/kas.js";
export { CredentialBroker, normalizeRepositoryUrl } from "./broker.js";
export { SandboxNotFoundError } from "./types.js";
export type { SandboxBackend } from "./types.js";
export default SandboxManager;

export const testing = { resolveConfig };
