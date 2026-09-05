import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-storage-domain";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import { CredentialBroker } from "../broker.js";
import {
  configSchema,
  resolveConfig,
  resolveRegistrationTokens,
  type Config,
  type ResolvedConfig,
} from "../config.js";
import {
  FileIndexStore,
  type FileIndex,
  type FileIndexOptions,
} from "../file-index.js";
import { InstructionStore } from "../instruction-store.js";
import type { InstructionSettingsView } from "../instructions-remote.js";
import { ManagedInstructions } from "../managed-instructions.js";
import { workbenchHost } from "../remote-contributions.js";
import type { RunnerClient } from "../runner-client.js";
import type { SessionProfileView } from "../session-profile-remote.js";
import { SessionStore } from "../state-store.js";
import { TunnelServer, type RunnerGateway } from "../tunnel.js";
import type { SandboxBackend } from "../types.js";
import {
  createRepositoryAnchor,
  repositoryForAnchor,
} from "../workspace-anchor.js";
import { ArchiveRelease, type SubagentsLike } from "./archive-release.js";
import { FileIndexHooks } from "./file-index-hooks.js";
import { IdleSchedule } from "./idle.js";
import { ProfileChoice } from "./profile-choice.js";
import { ProfileRegistry } from "./profile-registry.js";
import { RunnerAttachment } from "./runner-attachment.js";
import { SandboxLifecycle } from "./sandbox-lifecycle.js";

const execute = promisify(execFile);

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
  /** Sessions archived in the Web UI; dsh offers no unarchive, so the set only grows. */
  readonly archivedSessionIds: readonly string[];
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sandboxManager: SandboxManager;
  }
}

/**
 * The sandbox service surface dsh mounts: a Cordis plugin and typert RPC
 * host. All session machinery lives behind it — the lifecycle engine
 * (sandbox-lifecycle.ts), the runner attachment, the profile registry, and
 * the policies (idle, profile choice, file-index hooks) — wired
 * in the constructor; this class only composes them and delegates.
 */
export class SandboxManager extends TypertRemoteService {
  static inject = ["agents"];
  static Config = configSchema;

  readonly workspace: string;
  private readonly config: ResolvedConfig;
  private readonly broker: CredentialBroker;
  private readonly ownedTunnel: TunnelServer | undefined;
  private readonly instructions: ManagedInstructions;
  private readonly workspaceRegistry: WorkspaceRegistryLike | undefined;
  private readonly engine: SandboxLifecycle;
  private readonly idle: IdleSchedule;
  private readonly archiveRelease: ArchiveRelease;
  private readonly profileChoice: ProfileChoice;
  private readonly fileIndexHooks: FileIndexHooks;
  private readonly ready: Promise<void>;
  private readonly gateway: RunnerGateway;

  constructor(
    ctx: Context,
    config: Config,
    dependencies: ManagerDependencies = {},
  ) {
    super(ctx, "sandboxManager");
    this.config = resolveConfig(config);
    this.workspace = this.config.workspace;
    const store =
      dependencies.store ??
      new SessionStore(join(this.config.stateDir, "sessions.json"));
    this.broker =
      dependencies.broker ??
      new CredentialBroker({
        path: join(this.config.stateDir, "broker.json"),
      });
    const fileIndexes = new FileIndexStore(
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
    this.workspaceRegistry = dependencies.workspaceRegistry;
    this.profileChoice = new ProfileChoice(
      this.config.profiles,
      this.config.defaultProfile,
      store,
    );
    const attachment = new RunnerAttachment({
      gateway: this.gateway,
      broker: this.broker,
      revision: this.config.revision,
      workspace: this.config.workspace,
    });
    const registry = new ProfileRegistry(
      this.config.profiles,
      dependencies.backends,
      tokens[0],
    );
    this.engine = new SandboxLifecycle({
      store,
      registry,
      pendingProfile: (sessionId) => this.profileChoice.pending(sessionId),
      attachment,
      expiresAfterMs: this.config.expiresAfterMs,
      warn: (message) => this.ctx.logger("sandbox").warn(message),
    });
    this.fileIndexHooks = new FileIndexHooks({
      fileIndexes,
      store,
      workspace: this.config.workspace,
      warn: (message) => this.ctx.logger("sandbox").warn(message),
    });
    // Hooks run in registration order; file-index capture is the only
    // beforeHibernate step today. Add new hibernate-time features here.
    this.engine.addHooks(this.fileIndexHooks);
    this.instructions = new ManagedInstructions(ctx, {
      store:
        dependencies.instructions ??
        new InstructionStore(join(this.config.stateDir, "instructions.json")),
      stateDir: this.config.stateDir,
      ensureRunning: (agent) => this.ensureRunning(agent),
      repositoryForSession: (sessionId) =>
        this.engine.record(sessionId)?.repositoryUrl,
      workspaceRegistry: () =>
        this.workspaceRegistry ??
        (this.ctx.get("workspaceRegistry") as
          | WorkspaceRegistryLike
          | undefined),
    });
    this.idle = new IdleSchedule({
      idleMs: this.config.idleMs,
      ready: () => this.ready,
      hibernate: (sessionId, guard) => this.engine.hibernate(sessionId, guard),
    });
    this.archiveRelease = new ArchiveRelease({
      ready: () => this.ready,
      lifecycle: this.engine,
      archivedSessionIds: () => this.archivedSessionIds(),
      // TODO(dsh-archive-hook): interim bridge — dsh has no archive lifecycle
      // hook yet. ArchiveRelease.archivedDescendants owns the deletion note.
      subagents: () => this.ctx.get("subagents") as SubagentsLike | undefined,
      isTurnLive: (sessionId) => this.idle.isTurnLive(sessionId),
      warn: (message) => this.ctx.logger("sandbox").warn(message),
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
        this.idle.markActive(String(agent.id));
      }
    });
    ctx.on("session/event", (session, event) => {
      if (event.type === "turn/start") {
        this.idle.beginTurn(String(session.id));
      } else if (event.type === "turn/end") {
        this.idle.endTurn(session);
        // An archive that landed mid-turn waits for the turn to finish.
        this.archiveRelease.reconcile();
      }
    });
    // Archive release: dsh records archives in its workspace domain, so any
    // write there (and the registry becoming readable at boot) is a chance to
    // reconcile. Both are cheap: read the set, scan the few session records.
    ctx.on("domain/changed", (change) => {
      if (change.domain === "workspace") {
        this.archiveRelease.reconcile();
      }
    });
    ctx.inject(["workspaceRegistry"], () => {
      this.archiveRelease.reconcile();
    });
    ctx.effect(() => () => {
      this.idle.dispose();
      void this.ownedTunnel?.close();
    });
  }

  /** Load the stores, recover expired sandboxes, and arm boot idle timers. */
  private async initialize(): Promise<void> {
    await Promise.all([
      this.broker.initialize(),
      this.ownedTunnel?.listen(),
      this.instructions.initialize(),
    ]);
    await this.engine.initialize();
    for (const record of this.engine.records()) {
      if (record.state === "running") {
        this.idle.schedule(record.sessionId);
      }
    }
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
    return this.profileChoice.view(sessionId);
  }

  async setSessionProfile(
    sessionId: string,
    profile: string,
  ): Promise<SessionProfileView> {
    await this.ready;
    return this.profileChoice.set(sessionId, profile);
  }

  /**
   * A session is about to run: provision, wake, or recover its sandbox and
   * answer with the live runner.
   */
  async ensureRunning(agent: Agent): Promise<RunnerClient> {
    await this.ready;
    const sessionId = String(agent.id);
    this.idle.markActive(sessionId);
    const client = await this.engine.ensureRunning(sessionId, () =>
      this.repositoryFor(agent),
    );
    // markActive cancelled any armed countdown above, and a wake never
    // guarantees a turn follows (a created session can idle out untouched),
    // so re-arm here: a running record must always carry an idle timer.
    this.idle.schedule(sessionId);
    return client;
  }

  /** Suspend (or, without hibernation support, destroy) the session's sandbox. */
  async hibernate(sessionId: string): Promise<void> {
    await this.ready;
    await this.engine.hibernate(sessionId);
  }

  /**
   * Destroy the sandbox and drop the record of one session, whatever state it
   * is in. Skips a session with a live turn — a mid-stream destroy fails the
   * whole turn, so callers re-trigger after turn/end. Host-event features (an
   * archived session, an operator command) release through this verb.
   */
  async release(sessionId: string): Promise<void> {
    await this.ready;
    await this.engine.release(
      sessionId,
      () => !this.idle.isTurnLive(sessionId),
    );
  }

  /** The host's archive set, read through the workspace registry. */
  private archivedSessionIds(): readonly string[] {
    const registry =
      this.workspaceRegistry ??
      (this.ctx.get("workspaceRegistry") as WorkspaceRegistryLike | undefined);
    return registry?.archivedSessionIds ?? [];
  }

  /**
   * The "@" file-reference row saves a workspace index as each sandbox
   * hibernates, so discovery can answer for a hibernated session without
   * waking it. The capture lives in FileIndexHooks.
   */
  indexFilesOnHibernate(options: FileIndexOptions): void {
    this.fileIndexHooks.enable(options);
  }

  /**
   * The file index saved when this session hibernated. Undefined while the
   * sandbox is running (ask the runner instead), or when no index was saved.
   */
  async hibernatedFileIndex(agent: Agent): Promise<FileIndex | undefined> {
    await this.ready;
    return this.fileIndexHooks.hibernatedFileIndex(agent);
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
}

export default SandboxManager;
