import { metrics, trace } from "@opentelemetry/api";

import { normalizeRepositoryUrl } from "../broker.js";
import type { RunnerClient } from "../runner-client.js";
import type { SessionStore } from "../state-store.js";
import {
  SandboxNotFoundError,
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
   * Just before a live sandbox leaves the running state: a real suspend
   * (willSuspend, the runner still answers — index, commit, checkpoint) or a
   * destroy because the backend cannot suspend (willSuspend is false).
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
 * transitions between provisioned, running, hibernated, and gone. Knows
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
      const deadline =
        record.expiresAt === undefined ? undefined : new Date(record.expiresAt);
      if (
        deadline === undefined ||
        !Number.isFinite(deadline.getTime()) ||
        deadline.getTime() <= Date.now()
      ) {
        await this.releaseUnlocked(record.sessionId);
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
        await this.releaseUnlocked(record.sessionId);
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
    return this.serialize(sessionId, () =>
      this.releaseUnlocked(sessionId, guard),
    );
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
      record?.expiresAt !== undefined &&
      new Date(record.expiresAt).getTime() <= Date.now()
    ) {
      // Expiry already passed: reclaim loudly while we still can name the
      // backend, then provision fresh below.
      const backend = this.deps.registry.backendFor(record);
      await backend.destroy(record.reference);
      this.deps.attachment.drop(record.sandboxId);
      await this.forgetSession(sessionId);
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
        const { expiresAt: _expiredDeadline, ...durableRecord } = record;
        record = {
          ...durableRecord,
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
        await this.forgetSession(sessionId);
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

    return this.deps.attachment.attach(record, repositoryUrl);
  }

  private async hibernateUnlocked(sessionId: string): Promise<void> {
    const record = this.deps.store.get(sessionId);
    if (record === undefined || record.state === "hibernated") {
      return;
    }

    const backend = this.deps.registry.backendFor(record);
    const willSuspend = backend.capabilities.supportsHibernate;
    const client = this.deps.attachment.clientFor(sessionId);
    for (const hooks of this.hooks) {
      await hooks.beforeHibernate?.({ sessionId, record, willSuspend, client });
    }
    const deadline = new Date(Date.now() + this.deps.expiresAfterMs);
    try {
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
    this.deps.attachment.detach(sessionId, record.sandboxId);
  }

  private async releaseUnlocked(
    sessionId: string,
    guard?: () => boolean,
  ): Promise<void> {
    const record = this.deps.store.get(sessionId);
    if (record === undefined) {
      return;
    }
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
    this.deps.attachment.evict(sessionId);
    try {
      await backend.destroy(record.reference);
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) {
        throw error;
      }
      // The sandbox is already gone; its record still needs dropping.
    }
    this.deps.attachment.drop(record.sandboxId);
    await this.forgetSession(sessionId);
  }

  /** Drop the session record and everything derived from it. */
  private async forgetSession(sessionId: string): Promise<void> {
    await this.deps.store.delete(sessionId);
    for (const hooks of this.hooks) {
      await hooks.afterRelease?.(sessionId);
    }
  }
}

function orphanedRecordMessage(record: SessionRecord): string {
  return `session ${record.sessionId} has a ${record.backend} sandbox from profile ${record.profile}, which is no longer configured on that backend`;
}
