import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { metrics, trace } from "@opentelemetry/api";

import { DockerBackend } from "./backends/docker.js";
import { KasBackend } from "./backends/kas.js";
import { CredentialBroker, normalizeRepositoryUrl } from "./broker.js";
import {
  resolveConfig,
  resolveRegistrationTokens,
  type Config,
  type ResolvedConfig,
} from "./config.js";
import {
  captureFileIndex,
  FileIndexStore,
  type FileIndex,
  type FileIndexOptions,
} from "./file-index.js";
import { InstructionStore } from "./instruction-store.js";
import type { InstructionSettingsView } from "./instructions-remote.js";
import { ManagedInstructions } from "./managed-instructions.js";
import { workbenchHost } from "./remote-contributions.js";
import { DEFAULT_RUNNER_IMAGE } from "./runner-image.js";
import type { RunnerClient } from "./runner-client.js";
import type { SessionProfileView } from "./session-profile-remote.js";
import { SessionStore } from "./state-store.js";
import { TunnelServer, type RunnerGateway } from "./tunnel.js";
import type { SandboxBackend, SandboxProfile, SessionRecord } from "./types.js";
import { SandboxNotFoundError } from "./types.js";
import {
  createRepositoryAnchor,
  repositoryForAnchor,
} from "./workspace-anchor.js";

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

export interface ManagerDependencies {
  /** Replacement backends by profile name; a profile missing here gets one built from its settings. */
  backends?: Record<string, SandboxBackend>;
  store?: SessionStore;
  broker?: CredentialBroker;
  gateway?: RunnerGateway;
  instructions?: InstructionStore;
  workspaceRegistry?: WorkspaceRegistryLike;
}

interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<{ path: string }>;
  list(): Array<{ path: string; title: string }>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sandboxManager: SandboxManager;
  }
}

/** Owns one durable sandbox record per dsh session. */
export class SandboxManager extends TypertRemoteService {
  static inject = ["agents"];
  static Config: Schemastery<Config> = z.object({
    profiles: z
      .dict(
        z.union([
          z.object({
            backend: z.const("docker").required(),
            image: z.string().default(DEFAULT_RUNNER_IMAGE),
            binary: z.string(),
            hostUrl: z.string(),
          }),
          z.object({
            backend: z.const("kas").required(),
            namespace: z.string().default("dsh-sandbox"),
            warmPool: z.string().default("dsh-universal"),
            readyTimeoutMs: z.number().min(1).default(180_000),
            kubeconfig: z.string(),
          }),
        ]),
      )
      .required(),
    defaultProfile: z.string(),
    stateDir: z.string(),
    repository: z.string(),
    revision: z.string().default(""),
    workspace: z.string().default("/workspace/repository"),
    idleMs: z
      .number()
      .min(1)
      .default(10 * 60_000),
    expiresAfterMs: z
      .number()
      .min(1)
      .default(7 * 24 * 60 * 60_000),
    wipCommit: z.boolean().default(false),
    registrationToken: z.string(),
    tunnel: z.object({
      port: z.natural().min(1).max(65_535).default(8081),
      bind: z.string().default("0.0.0.0"),
    }),
  });

  readonly workspace: string;
  private readonly config: ResolvedConfig;
  private readonly backends: Map<string, SandboxBackend>;
  private readonly store: SessionStore;
  private readonly broker: CredentialBroker;
  private readonly gateway: RunnerGateway;
  private readonly ownedTunnel: TunnelServer | undefined;
  private readonly instructions: ManagedInstructions;
  private readonly workspaceRegistry: WorkspaceRegistryLike | undefined;
  private readonly ready: Promise<void>;
  private readonly operations = new Map<string, Promise<void>>();
  private readonly clients = new Map<string, RunnerClient>();
  private readonly fileIndexes: FileIndexStore;
  /** Set by the "@" file-reference row; absent means no index is captured. */
  private fileIndexOptions: FileIndexOptions | undefined;
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly activity = new Map<string, number>();
  /**
   * Sessions with a turn appended but not yet closed on the session log —
   * dsh-session pairs every turn/start with a turn/end (repair synthesizes
   * one after a crash). The activity counter is silent during a single long
   * generation, so this is the only signal that suspending would cut a live
   * turn. Rare — a generation has to outlast idleMs — but a mid-stream
   * suspend fails the whole turn, so the cheap check is worth keeping.
   */
  private readonly liveTurns = new Set<string>();

  constructor(
    ctx: Context,
    config: Config,
    dependencies: ManagerDependencies = {},
  ) {
    super(ctx, "sandboxManager");
    this.config = resolveConfig(config);
    this.workspace = this.config.workspace;
    this.store =
      dependencies.store ??
      new SessionStore(join(this.config.stateDir, "sessions.json"));
    this.broker =
      dependencies.broker ??
      new CredentialBroker({
        path: join(this.config.stateDir, "broker.json"),
      });
    this.fileIndexes = new FileIndexStore(
      join(this.config.stateDir, "file-index"),
    );
    const profiles = Object.values(this.config.profiles);
    const missingBackends = profiles.filter(
      (profile) => dependencies.backends?.[profile.name] === undefined,
    );
    let tokens: string[] = [];
    if (dependencies.gateway === undefined || missingBackends.length > 0) {
      tokens = resolveRegistrationTokens(this.config, profiles);
    }
    if (dependencies.gateway === undefined) {
      this.ownedTunnel = new TunnelServer({
        port: this.config.tunnel.port,
        bind: this.config.tunnel.bind,
        tokens,
        log: (message) => this.ctx.logger("sandbox").info(message),
      });
      this.gateway = this.ownedTunnel;
    } else {
      this.gateway = dependencies.gateway;
    }
    this.backends = new Map(
      profiles.map((profile) => [
        profile.name,
        dependencies.backends?.[profile.name] ??
          createBackend(profile, tokens[0] as string),
      ]),
    );
    this.workspaceRegistry = dependencies.workspaceRegistry;
    this.instructions = new ManagedInstructions(ctx, {
      store:
        dependencies.instructions ??
        new InstructionStore(join(this.config.stateDir, "instructions.json")),
      stateDir: this.config.stateDir,
      ensureRunning: (agent) => this.ensureRunning(agent),
      repositoryForSession: (sessionId) =>
        this.store.get(sessionId)?.repositoryUrl,
      workspaceRegistry: () =>
        this.workspaceRegistry ??
        (this.ctx.get("workspaceRegistry") as
          | WorkspaceRegistryLike
          | undefined),
    });
    this.ready = this.initialize();

    // The Web API requires a directory-picker capability. This package owns
    // the browser flow instead, so expose an unknown kind that makes the stock
    // folder RPCs unavailable without loading their competing browser plugin.
    ctx.provide("directoryPicker", {
      capability: () => ({ kind: "repository" }),
    });

    ctx.inject(["typert"], (typertCtx) => {
      typertCtx.typert.register(workbenchHost);
    });

    // Provisioning waits for the first prompt: `agent/session-start` fires as
    // soon as a blank session exists, before the user has picked a profile.
    // ManagedInstructions.install() calls ensureRunning at `agent/pre-step`.
    this.instructions.install();
    ctx.on("agent/status", ({ agent, status }) => {
      if (status === "running") {
        this.markActive(String(agent.id));
      }
    });
    ctx.on("session/event", (session, event) => {
      if (event.type === "turn/start") {
        this.liveTurns.add(String(session.id));
      } else if (event.type === "turn/end") {
        this.liveTurns.delete(String(session.id));
        this.scheduleIdle(session);
      }
    });
    ctx.effect(() => () => {
      for (const timer of this.idleTimers.values()) {
        clearTimeout(timer);
      }
      this.idleTimers.clear();
      void this.ownedTunnel?.close();
    });
  }

  /** Resolve the current foreground agent and return its live runner. */
  clientForCurrentAgent(): Promise<RunnerClient> {
    return this.ensureRunning(this.ctx.agents.requireInitiator());
  }

  /** Create and register the host Workspace selected by repository URL in Web. */
  async createRepositoryWorkspace(repositoryUrl: string): Promise<string> {
    const registry =
      this.workspaceRegistry ??
      (this.ctx.get("workspaceRegistry") as WorkspaceRegistryLike | undefined);
    if (registry === undefined) {
      throw new Error("repository workspaces require the dsh Web profile");
    }
    const anchor = await createRepositoryAnchor(
      this.config.stateDir,
      repositoryUrl,
    );
    return (await registry.create(anchor.path, anchor.title)).path;
  }

  /** Secret names for the Web page; refresh first so CLI edits appear. */
  async listSecrets(): Promise<string[]> {
    await this.ready;
    await this.broker.refresh();
    return this.broker.secretNames();
  }

  /** Store one secret and answer the updated names. Values never flow back. */
  async setSecret(name: string, value: string): Promise<string[]> {
    await this.ready;
    await this.broker.setSecret(name, value);
    return this.broker.secretNames();
  }

  async deleteSecret(name: string): Promise<string[]> {
    await this.ready;
    await this.broker.deleteSecret(name);
    return this.broker.secretNames();
  }

  async getInstructions(): Promise<InstructionSettingsView> {
    await this.ready;
    return this.instructions.getSettings();
  }

  async setGlobalInstructions(
    content: string,
  ): Promise<InstructionSettingsView> {
    await this.ready;
    return this.instructions.setGlobal(content);
  }

  async setWorkspaceInstructions(
    repositoryUrl: string,
    content: string,
  ): Promise<InstructionSettingsView> {
    await this.ready;
    return this.instructions.setWorkspace(repositoryUrl, content);
  }

  /** Profile choices for the composer chip; `locked` once a sandbox exists. */
  async getSessionProfile(sessionId: string): Promise<SessionProfileView> {
    await this.ready;
    return this.sessionProfileView(sessionId);
  }

  async setSessionProfile(
    sessionId: string,
    profile: string,
  ): Promise<SessionProfileView> {
    await this.ready;
    if (this.config.profiles[profile] === undefined) {
      throw new Error(`unknown sandbox profile: ${profile}`);
    }
    if (this.store.get(sessionId) !== undefined) {
      throw new Error("this session already has a sandbox");
    }
    await this.store.setPendingProfile(sessionId, profile);
    return this.sessionProfileView(sessionId);
  }

  private sessionProfileView(sessionId: string): SessionProfileView {
    const record = this.store.get(sessionId);
    return {
      profiles: Object.values(this.config.profiles).map(
        ({ name, backend }) => ({ name, backend }),
      ),
      selected:
        record === undefined
          ? this.pendingProfileFor(sessionId).name
          : record.profile,
      locked: record !== undefined,
    };
  }

  /** The profile a session without a sandbox would be provisioned with. */
  private pendingProfileFor(sessionId: string): SandboxProfile {
    const name =
      this.store.pendingProfile(sessionId) ?? this.config.defaultProfile;
    const profile = this.config.profiles[name];
    if (profile === undefined) {
      throw new Error(
        `sandbox profile ${name} is no longer configured; pick another profile`,
      );
    }
    return profile;
  }

  /**
   * The backend that owns a record's sandbox: the one built from the profile
   * the record was provisioned with. A profile that was removed, or renamed
   * onto another backend, cannot interpret the record's reference.
   */
  private findBackend(record: SessionRecord): SandboxBackend | undefined {
    const backend = this.backends.get(record.profile);
    return backend?.name === record.backend ? backend : undefined;
  }

  private backendFor(record: SessionRecord): SandboxBackend {
    const backend = this.findBackend(record);
    if (backend === undefined) {
      throw new Error(orphanedRecordMessage(record));
    }
    return backend;
  }

  async ensureRunning(agent: Agent): Promise<RunnerClient> {
    await this.ready;
    const sessionId = String(agent.id);
    this.markActive(sessionId);
    const client = await this.serialize(sessionId, () =>
      tracer.startActiveSpan("sandbox.ensure-running", async (span) => {
        try {
          return await this.ensureRunningUnlocked(agent);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: 2, message: String(error) });
          throw error;
        } finally {
          span.end();
        }
      }),
    );
    // markActive cancelled any armed countdown above, and a wake never
    // guarantees a turn follows (a created session can idle out untouched),
    // so re-arm here: a running record must always carry an idle timer.
    this.scheduleIdle(sessionId);
    return client;
  }

  async hibernate(sessionId: string): Promise<void> {
    await this.ready;
    await this.serialize(sessionId, () => this.hibernateUnlocked(sessionId));
  }

  /**
   * Save a workspace file index as each sandbox hibernates, so "@" discovery
   * can answer for a hibernated session without waking it.
   */
  indexFilesOnHibernate(options: FileIndexOptions): void {
    this.fileIndexOptions = options;
  }

  /**
   * The file index saved when this session hibernated. Undefined while the
   * sandbox is running (ask the runner instead), or when no index was saved.
   */
  async hibernatedFileIndex(agent: Agent): Promise<FileIndex | undefined> {
    await this.ready;
    const sessionId = String(agent.id);
    if (this.store.get(sessionId)?.state !== "hibernated") {
      return undefined;
    }
    return this.fileIndexes.load(sessionId);
  }

  private async hibernateUnlocked(sessionId: string): Promise<void> {
    const record = this.store.get(sessionId);
    if (record === undefined || record.state === "hibernated") {
      return;
    }

    const backend = this.backendFor(record);
    if (this.config.wipCommit) {
      await this.commitWorkInProgress(sessionId);
    }
    const deadline = new Date(Date.now() + this.config.expiresAfterMs);
    try {
      if (backend.capabilities.supportsHibernate) {
        // Index while the runner can still answer. Only a hibernated session
        // has a workspace to describe: the destroy branch below forgets the
        // session, and its next turn starts from a fresh clone.
        await this.saveFileIndex(sessionId);
        await backend.hibernate(record.reference);
        // Set the final deletion time after compute is suspended. If the
        // provider stops between these steps, the still-running local record
        // will recover and wake the same sandbox instead of leaving an active
        // sandbox with a hidden expiry.
        await backend.expireAt(record.reference, deadline);
        await this.store.set({
          ...record,
          state: "hibernated",
          expiresAt: deadline.toISOString(),
          updatedAt: new Date().toISOString(),
        });
        transitions.add(1, {
          backend: record.backend,
          transition: "hibernate",
        });
      } else {
        await backend.destroy(record.reference);
        await this.forgetSession(sessionId);
        transitions.add(1, {
          backend: record.backend,
          transition: "expire",
        });
      }
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) {
        throw error;
      }
      await this.forgetSession(sessionId);
      transitions.add(1, { backend: record.backend, transition: "missing" });
    }
    this.clients.delete(sessionId);
    this.gateway.drop(record.sandboxId);
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      this.store.initialize(),
      this.broker.initialize(),
      this.ownedTunnel?.listen(),
      this.instructions.initialize(),
    ]);
    for (const record of this.store.values()) {
      const backend = this.findBackend(record);
      if (backend === undefined) {
        // Keep the record: the operator may restore the profile and the
        // sandbox may hold unpushed work. Its session fails clearly.
        this.ctx.logger("sandbox").warn(orphanedRecordMessage(record));
        continue;
      }
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
        await backend.destroy(record.reference);
        await this.forgetSession(record.sessionId);
        continue;
      }
      try {
        await backend.expireAt(record.reference, deadline);
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) {
          throw error;
        }
        // A missing backend object means its external garbage collection won.
        // Remove the stale local record so the next turn provisions cleanly.
        await this.forgetSession(record.sessionId);
      }
    }
  }

  private async ensureRunningUnlocked(agent: Agent): Promise<RunnerClient> {
    const sessionId = String(agent.id);
    let record = this.store.get(sessionId);
    if (
      record?.expiresAt !== undefined &&
      new Date(record.expiresAt).getTime() <= Date.now()
    ) {
      await this.backendFor(record).destroy(record.reference);
      this.gateway.drop(record.sandboxId);
      await this.forgetSession(sessionId);
      record = undefined;
    }
    // Resolve the profile before any network work so a stale choice fails fast.
    let profile =
      record === undefined ? this.pendingProfileFor(sessionId) : undefined;

    const repositoryUrl =
      record?.repositoryUrl ??
      normalizeRepositoryUrl(await this.repositoryFor(agent));

    const cached = this.clients.get(sessionId);
    if (cached !== undefined && record?.state === "running") {
      try {
        const health = await cached.health({ timeoutMs: 5_000 });
        if (health.sandboxId !== record.sandboxId) {
          throw new Error("runner identity changed");
        }
        await this.broker.refresh();
        const credentials = await this.broker.gitCredentials(
          record.repositoryUrl,
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
      !(await this.backendFor(record).health(record.reference));

    await this.broker.refresh();
    const credentials = await this.broker.gitCredentials(repositoryUrl);

    if (
      record !== undefined &&
      (record.state === "hibernated" || runningSandboxNeedsRecovery)
    ) {
      const backend = this.backendFor(record);
      try {
        const started = Date.now();
        const handle = await backend.wake(record.reference);
        resumeLatency.record(Date.now() - started, {
          backend: record.backend,
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
        transitions.add(1, { backend: record.backend, transition: "wake" });
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) {
          throw error;
        }
        await backend.destroy(record.reference).catch(() => {});
        await this.forgetSession(sessionId);
        // The lost sandbox is replaced under the same profile (which
        // backendFor just proved is configured), so a session does not
        // silently change size or backend.
        profile = this.config.profiles[record.profile];
        record = undefined;
      }
    }

    if (record === undefined) {
      if (profile === undefined) {
        throw new Error("unreachable: no profile");
      }
      const backend = this.backends.get(profile.name);
      if (backend === undefined) {
        throw new Error(`unreachable: no backend for profile ${profile.name}`);
      }
      const started = Date.now();
      const handle = await backend.provision({ sessionId, repositoryUrl });
      claimLatency.record(Date.now() - started, { backend: profile.backend });
      record = {
        sessionId,
        backend: backend.name,
        profile: profile.name,
        sandboxId: handle.sandboxId,
        reference: handle.reference,
        repositoryUrl,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
      await this.store.set(record);
      transitions.add(1, {
        backend: profile.backend,
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
        const client = await this.gateway.waitFor(
          record.sandboxId,
          Math.max(deadline - Date.now(), 1),
        );
        const health = await client.health({ timeoutMs: 5_000 });
        if (health.sandboxId !== record.sandboxId) {
          throw new Error(
            `runner identity mismatch: expected ${record.sandboxId}, got ${health.sandboxId}`,
          );
        }
        return client;
      } catch (error) {
        lastError = error;
        // Sever a registration whose tunnel cannot answer a health probe so
        // the runner reconnects instead of staying wedged.
        this.gateway.drop(record.sandboxId);
        await delay(500);
      }
    }
    throw new Error(`runner did not become healthy: ${String(lastError)}`);
  }

  private async repositoryFor(agent: Agent): Promise<string> {
    const cwd = agent.session.header.cwd;
    if (cwd !== undefined) {
      const repository = await repositoryForAnchor(this.config.stateDir, cwd);
      if (repository !== undefined) {
        return repository;
      }
    }
    if (this.config.repository !== undefined) {
      return this.config.repository;
    }
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
      if (repository.length === 0) {
        throw new Error("origin is empty");
      }
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
      if ((this.activity.get(sessionId) ?? 0) !== expectedActivity) {
        return;
      }
      // A live turn holds no countdown of its own, and a timer this wake
      // re-armed must not suspend under it: retry until turn/end re-arms.
      if (this.liveTurns.has(sessionId)) {
        this.scheduleIdle(sessionId);
        return;
      }
      await this.hibernateUnlocked(sessionId);
    });
  }

  private markActive(sessionId: string): void {
    this.cancelIdle(sessionId);
    this.activity.set(sessionId, (this.activity.get(sessionId) ?? 0) + 1);
  }

  private cancelIdle(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
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
      if (this.operations.get(sessionId) === tail) {
        this.operations.delete(sessionId);
      }
    });
    return result;
  }

  /** Drop the session record and everything derived from it. */
  private async forgetSession(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
    await this.fileIndexes.remove(sessionId);
  }

  /**
   * Index the workspace through the still-running runner. A failure here only
   * costs the fast path ("@" then wakes the sandbox), so it never blocks
   * hibernation.
   */
  private async saveFileIndex(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (client === undefined || this.fileIndexOptions === undefined) {
      return;
    }
    try {
      const index = await captureFileIndex(
        client,
        this.config.workspace,
        this.fileIndexOptions,
      );
      await this.fileIndexes.save(sessionId, index);
    } catch (error) {
      await this.fileIndexes.remove(sessionId).catch(() => {});
      this.ctx
        .logger("sandbox")
        .warn(
          `could not index files for ${sessionId} before hibernation: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }

  private async commitWorkInProgress(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (client === undefined) {
      return;
    }
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

function createBackend(
  profile: SandboxProfile,
  registrationToken: string,
): SandboxBackend {
  if (profile.backend === "docker") {
    const { name: _name, backend: _backend, ...options } = profile;
    return new DockerBackend({ ...options, registrationToken });
  }
  const { name: _name, backend: _backend, ...options } = profile;
  return new KasBackend(options);
}

function orphanedRecordMessage(record: SessionRecord): string {
  return `session ${record.sessionId} has a ${record.backend} sandbox from profile ${record.profile}, which is no longer configured on that backend`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export default SandboxManager;
