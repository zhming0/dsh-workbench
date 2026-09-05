import { metrics, trace } from "@opentelemetry/api";

import { normalizeRepositoryUrl } from "../broker.js";
import type { RunnerClient } from "../runner-client.js";
import type { SessionStore } from "../state-store.js";
import {
  SandboxNotFoundError,
  type CheckpointedRecord,
  type SandboxProfile,
  type SessionRecord,
} from "../types.js";
import type { ProfileRegistry } from "./profile-registry.js";
import type { RunnerAttachment } from "./runner-attachment.js";

const tracer = trace.getTracer("dsh-sandbox-provider");
const meter = metrics.getMeter("dsh-sandbox-provider");
const claimLatency = meter.createHistogram("dsh.sandbox.claim.duration", {
  unit: "ms",
});
const resumeLatency = meter.createHistogram("dsh.sandbox.resume.duration", {
  unit: "ms",
});
const transitions = meter.createCounter("dsh.sandbox.lifecycle.transitions");

/**
 * Where features may hook the lifecycle. The engine defines the seams; a
 * feature that needs one registers here instead of the engine calling it by
 * name, so adding a hibernate-time or release-time feature changes no engine
 * code.
 */
export interface LifecycleHooks {
  /**
   * Just before a live sandbox leaves the running state, while the runner
   * still answers: a real suspend (willSuspend, the session ends up
   * hibernated) or a checkpoint-then-destroy because the backend cannot
   * suspend (willSuspend is false, the session ends up checkpointed). Either
   * way the next turn shows this workspace again.
   */
  beforeHibernate?(context: {
    sessionId: string;
    record: SessionRecord;
    willSuspend: boolean;
    client: RunnerClient | undefined;
  }): Promise<void>;
  /** The session's record is gone; drop anything derived from it. */
  afterRelease?(sessionId: string): Promise<void>;
}

export interface SandboxLifecycleDependencies {
  store: SessionStore;
  registry: ProfileRegistry;
  /** The profile a session without a sandbox is provisioned with. */
  pendingProfile(sessionId: string): SandboxProfile;
  attachment: RunnerAttachment;
  expiresAfterMs: number;
  warn(message: string): void;
}

/**
 * The sandbox session lifecycle: one durable record per session and the
 * transitions between provisioned, running, hibernated, checkpointed (the
 * work is on the remote and no sandbox exists), and gone. Knows
 * nothing about Cordis, agents, timers, or RPC — callers (the manager facade,
 * idle policy, host-event features) decide when an op runs and hand in what
 * the op needs (a repository for provisioning, a guard for release). Every
 * per-session operation is serialized through the session's lock.
 */
export class SandboxLifecycle {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly hooks: LifecycleHooks[] = [];

  constructor(private readonly deps: SandboxLifecycleDependencies) {}

  /** Register a feature that wants lifecycle seams. */
  addHooks(hooks: LifecycleHooks): void {
    this.hooks.push(hooks);
  }

  /** The stored record of one session. */
  record(sessionId: string): SessionRecord | undefined {
    return this.deps.store.get(sessionId);
  }

  /** Every stored record. */
  records(): SessionRecord[] {
    return this.deps.store.values();
  }

  /**
   * Boot recovery: load the session records, destroy sandboxes whose
   * retention expired while the host was down, and re-arm expiry on the
   * rest. Call once after the stores are loaded and the hooks are registered.
   */
  async initialize(): Promise<void> {
    await this.deps.store.initialize();
    for (const record of this.records()) {
      const backend = this.deps.registry.findBackend(record);
      if (backend === undefined) {
        // Keep the record: the operator may restore the profile and the
        // sandbox may hold unpushed work. Its session fails clearly.
        this.deps.warn(orphanedRecordMessage(record));
        continue;
      }
      if (record.state === "running") {
        continue;
      }
      const deadline = new Date(record.expiresAt);
      if (
        !Number.isFinite(deadline.getTime()) ||
        deadline.getTime() <= Date.now()
      ) {
        await this.releaseUnlocked(record);
        continue;
      }
      if (record.state === "checkpointed") {
        // No sandbox is left to put a deadline on; ensureRunning enforces
        // expiresAt itself on the next turn.
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
        await this.releaseUnlocked(record);
      }
    }
  }

  /**
   * A session is about to run: return its live runner, provisioning a new
   * sandbox, waking a hibernated one, or recovering a dead one as needed.
   * `repository` resolves the repository URL and is only consulted when the
   * session has no record yet.
   */
  ensureRunning(
    sessionId: string,
    repository: () => Promise<string>,
  ): Promise<RunnerClient> {
    return this.serialize(sessionId, () =>
      tracer.startActiveSpan("sandbox.ensure-running", async (span) => {
        try {
          return await this.ensureRunningUnlocked(sessionId, repository);
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

  /**
   * Suspend (or, without hibernation support, destroy) the session's sandbox.
   * The optional guard re-checks inside the lock; when it refuses (a live
   * turn must not be cut) nothing changes and hibernate answers false, so
   * the caller re-triggers after turn/end.
   */
  hibernate(sessionId: string, guard?: () => boolean): Promise<boolean> {
    return this.serialize(sessionId, async () => {
      if (guard !== undefined && !guard()) {
        return false;
      }
      await this.hibernateUnlocked(sessionId);
      return true;
    });
  }

  /**
   * Destroy the sandbox and drop the record of one session, whatever state it
   * is in. The optional guard re-checks inside the lock (a live turn must not
   * be cut); callers re-trigger after turn/end when the guard refuses.
   */
  release(sessionId: string, guard?: () => boolean): Promise<void> {
    return this.serialize(sessionId, async () => {
      const record = this.deps.store.get(sessionId);
      if (record !== undefined) {
        await this.releaseUnlocked(record, guard);
      }
    });
  }

  /** Run one operation under the session's exclusive lock. */
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

  private async ensureRunningUnlocked(
    sessionId: string,
    repository: () => Promise<string>,
  ): Promise<RunnerClient> {
    let record = this.deps.store.get(sessionId);
    if (
      record !== undefined &&
      record.state !== "running" &&
      new Date(record.expiresAt).getTime() <= Date.now()
    ) {
      // Expiry already passed: reclaim loudly while we still can name the
      // backend, then provision fresh below.
      if (record.state === "hibernated") {
        const backend = this.deps.registry.backendFor(record);
        await backend.destroy(record.reference);
        this.deps.attachment.drop(record.sandboxId);
      }
      await this.forgetSession(record);
      record = undefined;
    }
    // Resolve the profile before any network work so a stale choice fails fast.
    let profile =
      record === undefined ? this.deps.pendingProfile(sessionId) : undefined;

    const repositoryUrl =
      record?.repositoryUrl ?? normalizeRepositoryUrl(await repository());

    const cached = await this.deps.attachment.reuseCached(sessionId, record);
    if (cached !== undefined) {
      return cached;
    }

    const runningSandboxNeedsRecovery =
      record?.state === "running" &&
      !(await this.deps.registry.backendFor(record).health(record.reference));

    let checkpointed: CheckpointedRecord | undefined;
    if (record?.state === "checkpointed") {
      // The work is on the remote, not in a sandbox: provision again under the
      // same profile and restore it there.
      checkpointed = record;
      profile = this.deps.registry.profile(record.profile);
      record = undefined;
    }

    if (
      record !== undefined &&
      (record.state === "hibernated" || runningSandboxNeedsRecovery)
    ) {
      const backend = this.deps.registry.backendFor(record);
      try {
        const started = Date.now();
        const handle = await backend.wake(record.reference);
        resumeLatency.record(Date.now() - started, {
          backend: record.backend,
        });
        record = {
          sessionId: record.sessionId,
          backend: record.backend,
          profile: record.profile,
          repositoryUrl: record.repositoryUrl,
          sandboxId: handle.sandboxId,
          reference: handle.reference,
          state: "running",
          updatedAt: new Date().toISOString(),
        };
        await this.deps.store.set(record);
        transitions.add(1, { backend: record.backend, transition: "wake" });
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) {
          throw error;
        }
        await backend.destroy(record.reference).catch(() => {});
        await this.forgetSession(record);
        // The lost sandbox is replaced under the same profile (which
        // backendFor just proved is configured), so a session does not
        // silently change size or backend.
        profile = this.deps.registry.profile(record.profile);
        record = undefined;
      }
    }

    if (record === undefined) {
      if (profile === undefined) {
        throw new Error("unreachable: no profile");
      }
      const backend = this.deps.registry.backendOf(profile.name);
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
      await this.deps.store.set(record);
      transitions.add(1, {
        backend: profile.backend,
        transition: "provision",
      });
    }

    if (checkpointed === undefined) {
      return this.deps.attachment.attach(record, repositoryUrl);
    }
    try {
      const client = await this.deps.attachment.attach(
        record,
        repositoryUrl,
        checkpointed.checkpoint,
      );
      transitions.add(1, { backend: record.backend, transition: "restore" });
      return client;
    } catch (error) {
      // The pushed branch is still the truth. Give the sandbox up and keep the
      // checkpointed record so the next turn tries again from scratch.
      const backend = this.deps.registry.backendFor(record);
      await backend.destroy(record.reference).catch(() => {});
      this.deps.attachment.detach(sessionId, record.sandboxId);
      await this.deps.store.set({
        ...checkpointed,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private async hibernateUnlocked(sessionId: string): Promise<void> {
    const record = this.deps.store.get(sessionId);
    if (record === undefined || record.state !== "running") {
      return;
    }

    const backend = this.deps.registry.backendFor(record);
    const willSuspend = backend.capabilities.supportsHibernate;
    const deadline = new Date(Date.now() + this.deps.expiresAfterMs);
    try {
      let client = this.deps.attachment.clientFor(sessionId);
      if (!willSuspend && client === undefined) {
        // The working tree must be pushed before the sandbox goes away, so the
        // hooks and the checkpoint both need the runner. After a host restart
        // nothing is cached: confirm the sandbox is still there (one that is
        // gone has nothing left to save), then reconnect.
        if (!(await backend.health(record.reference))) {
          throw new SandboxNotFoundError(
            `sandbox ${record.sandboxId} is no longer running`,
          );
        }
        client = await this.deps.attachment.connect(record);
      }
      for (const hooks of this.hooks) {
        await hooks.beforeHibernate?.({
          sessionId,
          record,
          willSuspend,
          client,
        });
      }
      if (willSuspend) {
        await backend.hibernate(record.reference);
        // Set the final deletion time after compute is suspended. If the
        // provider stops between these steps, the still-running local record
        // will recover and wake the same sandbox instead of leaving an active
        // sandbox with a hidden expiry.
        await backend.expireAt(record.reference, deadline);
        await this.deps.store.set({
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
        // The sandbox cannot be kept, so push the working tree to the remote
        // first. A failed push throws before destroy: the sandbox stays up and
        // the idle timer tries again.
        const checkpoint = await this.deps.attachment.checkpoint(record);
        await backend.destroy(record.reference);
        await this.deps.store.set({
          sessionId: record.sessionId,
          backend: record.backend,
          profile: record.profile,
          repositoryUrl: record.repositoryUrl,
          state: "checkpointed",
          checkpoint,
          expiresAt: deadline.toISOString(),
          updatedAt: new Date().toISOString(),
        });
        transitions.add(1, {
          backend: record.backend,
          transition: "checkpoint",
        });
      }
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) {
        throw error;
      }
      await this.forgetSession(record);
      transitions.add(1, { backend: record.backend, transition: "missing" });
    }
    this.deps.attachment.detach(sessionId, record.sandboxId);
  }

  private async releaseUnlocked(
    record: SessionRecord,
    guard?: () => boolean,
  ): Promise<void> {
    if (guard !== undefined && !guard()) {
      return;
    }
    const backend = this.deps.registry.findBackend(record);
    if (backend === undefined) {
      // Same posture as startup: the profile may return, and expiry still
      // bounds a sandbox this provider cannot reach.
      this.deps.warn(orphanedRecordMessage(record));
      return;
    }
    this.deps.attachment.evict(record.sessionId);
    if (record.state !== "checkpointed") {
      try {
        await backend.destroy(record.reference);
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) {
          throw error;
        }
        // The sandbox is already gone; its record still needs dropping.
      }
      this.deps.attachment.drop(record.sandboxId);
    }
    await this.forgetSession(record);
  }

  /** Drop the session record and everything derived from it. */
  private async forgetSession(record: SessionRecord): Promise<void> {
    await this.deps.store.delete(record.sessionId);
    for (const hooks of this.hooks) {
      await hooks.afterRelease?.(record.sessionId);
    }
  }
}

function orphanedRecordMessage(record: SessionRecord): string {
  return `session ${record.sessionId} has a ${record.backend} sandbox from profile ${record.profile}, which is no longer configured on that backend`;
}
