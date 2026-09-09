import { metrics, trace } from "@opentelemetry/api";

import { normalizeRepositoryUrl } from "../broker.js";
import type { CheckpointStore } from "../checkpoint.js";
import type { RunnerClient } from "../runner-client.js";
import type { SessionStore } from "../state-store.js";
import {
  SandboxNotFoundError,
  type CheckpointedRecord,
  type HibernatedRecord,
  type RunningRecord,
  type SandboxBackend,
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
   * Just before a live sandbox hibernates. The runner still answers, but only
   * a cached client is offered: after a host restart there is none, and
   * hibernation does not reconnect for it.
   */
  beforeHibernate?(context: {
    sessionId: string;
    record: RunningRecord;
    client: RunnerClient | undefined;
  }): Promise<void>;
  /**
   * Just before a sandbox that cannot hibernate has its working tree saved
   * and is destroyed. The runner is connected, because the save needs it too.
   */
  beforeCheckpoint?(context: {
    sessionId: string;
    record: RunningRecord;
    client: RunnerClient;
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
  /** The bundles of checkpointed sessions, keyed by session. */
  checkpoints: CheckpointStore;
  expiresAfterMs: number;
  warn(message: string): void;
}

/** The ensureRunning event: a session needs its live runner. */
interface EnsureEvent {
  type: "ensureRunning";
  repository: () => Promise<string>;
}

/** The hibernate event: an idle countdown or an operator asked for a suspend. */
interface HibernateEvent {
  type: "hibernate";
}

/** The release event: the sandbox must go and the record with it. */
interface ReleaseEvent {
  type: "release";
}

/**
 * What the world can tell the machine, one per public verb below. The
 * machine, not the caller, decides what an event means for the session's
 * current state.
 */
type LifecycleEvent = EnsureEvent | HibernateEvent | ReleaseEvent;

/**
 * The sandbox session lifecycle as a small event-driven state machine: one
 * durable record per session whose `state` is `running`, `hibernated`, or
 * `checkpointed` (no sandbox exists; the work is a git bundle on the host),
 * with no record at all as the fourth state, absent. Callers do not name
 * procedures; they report what happened (a session needs its runner, an idle
 * countdown fired, a session is being discarded) and the machine picks the
 * reaction for the state the session is in.
 *
 * Knows nothing about Cordis, agents, timers, or RPC — callers (the manager
 * facade, idle policy, host-event features) decide when an event fires and
 * hand in what the reaction needs (a repository for provisioning, a guard
 * for release). Every event is serialized through the session's lock.
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
   * Boot recovery: load the session records, then replay a release event for
   * each one whose retention expired while the host was down. Call once
   * after the stores are loaded and the hooks are registered.
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
        await this.react(record.sessionId, { type: "release" });
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
        await this.react(record.sessionId, { type: "release" });
      }
    }
  }

  /**
   * A session is about to run: return its live runner. The machine answers
   * from the state the session is in — provisioning its first sandbox,
   * waking a hibernated one, or recovering a dead one. `repository` resolves
   * the repository URL and is only consulted when the session has no record
   * yet.
   */
  ensureRunning(
    sessionId: string,
    repository: () => Promise<string>,
  ): Promise<RunnerClient> {
    return this.serialize(sessionId, () =>
      tracer.startActiveSpan("sandbox.ensure-running", async (span) => {
        try {
          return await this.react(sessionId, {
            type: "ensureRunning",
            repository,
          });
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
   * Suspend the session's sandbox: hibernate it, or, when the backend cannot
   * hibernate, checkpoint its working tree on the host and destroy it.
   * The optional guard re-checks inside the lock; when it refuses (a live
   * turn must not be cut) nothing changes and hibernate answers false, so
   * the caller re-triggers after turn/end.
   */
  hibernate(sessionId: string, guard?: () => boolean): Promise<boolean> {
    return this.serialize(sessionId, async () => {
      if (guard !== undefined && !guard()) {
        return false;
      }
      await this.react(sessionId, { type: "hibernate" });
      return true;
    });
  }

  /**
   * Destroy the sandbox and drop the record of one session, whatever state it
   * is in. The optional guard re-checks inside the lock, and only when a
   * record exists to release (a live turn must not be cut); callers
   * re-trigger after turn/end when the guard refuses.
   */
  release(sessionId: string, guard?: () => boolean): Promise<void> {
    return this.serialize(sessionId, async () => {
      if (this.record(sessionId) === undefined) {
        return;
      }
      if (guard !== undefined && !guard()) {
        return;
      }
      await this.react(sessionId, { type: "release" });
    });
  }

  /**
   * The machine itself: read the session's state, react to the event there.
   * Each overload pairs an event with the type its reaction answers, so the
   * verbs get precise results out of the shared dispatcher.
   *
   * Only ensureRunning consults expiry, and it does so before dispatch: a
   * deadline that has passed reclaims the sandbox whatever the record
   * claims, and the machine answers the same event again with the session
   * absent. Hibernate and release deliberately skip that check — a lapsed
   * session still suspends (with a fresh deadline) or releases cleanly.
   */
  private react(sessionId: string, event: EnsureEvent): Promise<RunnerClient>;
  private react(
    sessionId: string,
    event: HibernateEvent | ReleaseEvent,
  ): Promise<void>;
  private async react(
    sessionId: string,
    event: LifecycleEvent,
  ): Promise<unknown> {
    const record = this.deps.store.get(sessionId);
    if (
      event.type === "ensureRunning" &&
      record !== undefined &&
      this.hasExpired(record)
    ) {
      await this.reclaimExpired(record);
      return this.react(sessionId, event);
    }
    if (record === undefined) {
      return this.whenAbsent(sessionId, event);
    }
    switch (record.state) {
      case "running":
        return this.whenRunning(record, event);
      case "hibernated":
        return this.whenHibernated(record, event);
      case "checkpointed":
        return this.whenCheckpointed(record, event);
    }
  }

  /** Row `absent`: no sandbox exists yet, so there is nothing to stop. */
  private async whenAbsent(
    sessionId: string,
    event: LifecycleEvent,
  ): Promise<unknown> {
    switch (event.type) {
      case "ensureRunning":
        return this.provisionFresh(sessionId, event.repository);
      case "hibernate":
      case "release":
        return undefined;
    }
  }

  /** Row `running`: the sandbox lives; events steer it or stop it. */
  private async whenRunning(
    record: RunningRecord,
    event: LifecycleEvent,
  ): Promise<unknown> {
    switch (event.type) {
      case "ensureRunning":
        return this.serveRunning(record);
      case "hibernate":
        return this.suspendRunning(record);
      case "release":
        return this.releaseSession(record);
    }
  }

  /** Row `hibernated`: the sandbox is parked; ensureRunning wakes it. */
  private async whenHibernated(
    record: HibernatedRecord,
    event: LifecycleEvent,
  ): Promise<unknown> {
    switch (event.type) {
      case "ensureRunning":
        return this.wakeOrReplace(record, record.repositoryUrl);
      case "hibernate":
        // Already parked; a second request changes nothing.
        return undefined;
      case "release":
        return this.releaseSession(record);
    }
  }

  /**
   * Row `checkpointed`: no sandbox exists, the work is a bundle on the host;
   * ensureRunning provisions a fresh sandbox and restores it there.
   */
  private async whenCheckpointed(
    record: CheckpointedRecord,
    event: LifecycleEvent,
  ): Promise<unknown> {
    switch (event.type) {
      case "ensureRunning":
        return this.restoreCheckpoint(record);
      case "hibernate":
        // Nothing is running; a second request changes nothing.
        return undefined;
      case "release":
        return this.releaseSession(record);
    }
  }

  /**
   * absent → running on ensureRunning: the session's first sandbox,
   * provisioned from its pending profile.
   */
  private async provisionFresh(
    sessionId: string,
    repository: () => Promise<string>,
  ): Promise<RunnerClient> {
    // Resolve the profile before any network work so a stale choice fails fast.
    const profile = this.deps.pendingProfile(sessionId);
    const repositoryUrl = normalizeRepositoryUrl(await repository());
    const record = await this.provision(sessionId, profile, repositoryUrl);
    return this.deps.attachment.attach(record, repositoryUrl);
  }

  /**
   * running on ensureRunning: answer the cached runner when it still works;
   * otherwise ask the backend — a healthy sandbox only needs its runner
   * re-attached, a dead one is recovered by waking it.
   */
  private async serveRunning(record: RunningRecord): Promise<RunnerClient> {
    const cached = await this.deps.attachment.reuseCached(
      record.sessionId,
      record,
    );
    if (cached !== undefined) {
      return cached;
    }
    const backend = this.deps.registry.backendFor(record);
    if (await backend.health(record.reference)) {
      return this.deps.attachment.attach(record, record.repositoryUrl);
    }
    return this.wakeOrReplace(record, record.repositoryUrl);
  }

  /**
   * running → hibernated on hibernate, or running → checkpointed when the
   * backend cannot hibernate; or forget a sandbox the backend already lost.
   * Either way the session's runner is detached.
   */
  private async suspendRunning(record: RunningRecord): Promise<void> {
    const backend = this.deps.registry.backendFor(record);
    try {
      if (backend.capabilities.supportsHibernate) {
        await this.hibernateSandbox(record, backend);
      } else {
        await this.checkpointSandbox(record, backend);
      }
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) {
        throw error;
      }
      await this.forgetSession(record.sessionId);
      transitions.add(1, { backend: record.backend, transition: "missing" });
    }
    this.deps.attachment.detach(record.sessionId, record.sandboxId);
  }

  /**
   * The runner a checkpoint needs: the working tree must be saved before the
   * sandbox goes away, so the hooks and the save both need it. After a host
   * restart nothing is cached: confirm the sandbox is still there (one that
   * is gone has nothing left to save), then reconnect.
   */
  private async runnerForCheckpoint(
    record: RunningRecord,
    backend: SandboxBackend,
  ): Promise<RunnerClient> {
    const cached = this.deps.attachment.clientFor(record.sessionId);
    if (cached !== undefined) {
      return cached;
    }
    if (!(await backend.health(record.reference))) {
      throw new SandboxNotFoundError(
        `sandbox ${record.sandboxId} is no longer running`,
      );
    }
    return this.deps.attachment.connect(record);
  }

  /**
   * The running → hibernated transition: run the beforeHibernate seams, then
   * pause compute and keep the sandbox.
   */
  private async hibernateSandbox(
    record: RunningRecord,
    backend: SandboxBackend,
  ): Promise<void> {
    const client = this.deps.attachment.clientFor(record.sessionId);
    for (const hooks of this.hooks) {
      await hooks.beforeHibernate?.({
        sessionId: record.sessionId,
        record,
        client,
      });
    }
    const deadline = new Date(Date.now() + this.deps.expiresAfterMs);
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
    transitions.add(1, { backend: record.backend, transition: "hibernate" });
  }

  /**
   * The running → checkpointed transition: the sandbox cannot be kept, so
   * run the beforeCheckpoint seams, bring the working tree out and put it on
   * host disk, then destroy. A failed save throws before anything changes:
   * the sandbox stays up and the idle timer tries again.
   *
   * The record says checkpointed before the sandbox goes. A crash in between
   * leaks one sandbox, which the backend's own limits bound; the other order
   * would leave a running record pointing at a dead sandbox, and the next
   * turn would replace it with a fresh clone while the bundle sat unused.
   */
  private async checkpointSandbox(
    record: RunningRecord,
    backend: SandboxBackend,
  ): Promise<void> {
    const client = await this.runnerForCheckpoint(record, backend);
    for (const hooks of this.hooks) {
      await hooks.beforeCheckpoint?.({
        sessionId: record.sessionId,
        record,
        client,
      });
    }
    const deadline = new Date(Date.now() + this.deps.expiresAfterMs);
    const { checkpoint, bundle } =
      await this.deps.attachment.checkpoint(record);
    await this.deps.checkpoints.save(record.sessionId, bundle);
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
    transitions.add(1, { backend: record.backend, transition: "checkpoint" });
    await backend.destroy(record.reference).catch((error: unknown) => {
      // Already gone is the outcome we wanted; the record must stay.
      if (!(error instanceof SandboxNotFoundError)) {
        throw error;
      }
    });
  }

  /**
   * running|hibernated|checkpointed → gone on release: destroy the sandbox,
   * when there is one, and drop the record. An orphaned record — a profile
   * this registry can no longer serve — is kept and reported, exactly as at
   * boot.
   */
  private async releaseSession(record: SessionRecord): Promise<void> {
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
    await this.forgetSession(record.sessionId);
  }

  /** The absent → running transition: create the sandbox, write the record. */
  private async provision(
    sessionId: string,
    profile: SandboxProfile,
    repositoryUrl: string,
  ): Promise<RunningRecord> {
    const record = await this.claimSandbox(sessionId, profile, repositoryUrl);
    await this.deps.store.set(record);
    transitions.add(1, {
      backend: profile.backend,
      transition: "provision",
    });
    return record;
  }

  /** Create a sandbox and describe it as a running record, without storing it. */
  private async claimSandbox(
    sessionId: string,
    profile: SandboxProfile,
    repositoryUrl: string,
  ): Promise<RunningRecord> {
    const backend = this.deps.registry.backendOf(profile.name);
    if (backend === undefined) {
      throw new Error(`unreachable: no backend for profile ${profile.name}`);
    }
    const started = Date.now();
    const handle = await backend.provision({ sessionId, repositoryUrl });
    claimLatency.record(Date.now() - started, { backend: profile.backend });
    return {
      sessionId,
      backend: backend.name,
      profile: profile.name,
      sandboxId: handle.sandboxId,
      reference: handle.reference,
      repositoryUrl,
      state: "running",
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * The hibernated-or-dead → running transition: wake the sandbox, or, when
   * the backend has lost the object, provision a replacement under the same
   * profile (which backendFor just proved is configured), so a session does
   * not silently change size or backend.
   */
  private async wakeOrReplace(
    record: RunningRecord | HibernatedRecord,
    repositoryUrl: string,
  ): Promise<RunnerClient> {
    const backend = this.deps.registry.backendFor(record);
    try {
      const started = Date.now();
      const handle = await backend.wake(record.reference);
      resumeLatency.record(Date.now() - started, {
        backend: record.backend,
      });
      const woken: RunningRecord = {
        sessionId: record.sessionId,
        backend: record.backend,
        profile: record.profile,
        repositoryUrl: record.repositoryUrl,
        sandboxId: handle.sandboxId,
        reference: handle.reference,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
      await this.deps.store.set(woken);
      transitions.add(1, { backend: record.backend, transition: "wake" });
      return this.deps.attachment.attach(woken, repositoryUrl);
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) {
        throw error;
      }
      return this.replaceLostSandbox(backend, record, repositoryUrl);
    }
  }

  /**
   * The backend lost the sandbox: destroy the leftovers, drop the record,
   * and provision a replacement under the same profile (which backendFor
   * just proved is configured), so a session does not silently change size
   * or backend.
   */
  private async replaceLostSandbox(
    backend: SandboxBackend,
    record: RunningRecord | HibernatedRecord,
    repositoryUrl: string,
  ): Promise<RunnerClient> {
    await backend.destroy(record.reference).catch(() => {});
    await this.forgetSession(record.sessionId);
    const profile = this.deps.registry.profile(record.profile);
    if (profile === undefined) {
      throw new Error("unreachable: no profile");
    }
    const replacement = await this.provision(
      record.sessionId,
      profile,
      repositoryUrl,
    );
    return this.deps.attachment.attach(replacement, repositoryUrl);
  }

  /**
   * The checkpointed → running transition: provision a fresh sandbox under
   * the same profile and put the bundle's commits and working tree back in
   * it. The bundle is read first so a lost one fails before a sandbox is
   * spent on it.
   *
   * The record stays checkpointed until the restore has succeeded, so a
   * failure or a host crash in between leaves the bundle as the truth and
   * the next turn tries again from scratch. A crash costs one leaked
   * sandbox, which the backend's own limits bound; a running record written
   * earlier would cost the work instead, because the next turn would attach
   * to the half-restored clone and never look at the bundle.
   */
  private async restoreCheckpoint(
    record: CheckpointedRecord,
  ): Promise<RunnerClient> {
    const bundle = await this.deps.checkpoints.load(record.sessionId);
    if (bundle === undefined) {
      throw new Error(
        `the checkpoint of session ${record.sessionId} is missing from the host's state directory`,
      );
    }
    const profile = this.deps.registry.profile(record.profile);
    if (profile === undefined) {
      throw new Error("unreachable: no profile");
    }
    const replacement = await this.claimSandbox(
      record.sessionId,
      profile,
      record.repositoryUrl,
    );
    let client: RunnerClient;
    try {
      client = await this.deps.attachment.attach(
        replacement,
        record.repositoryUrl,
        { checkpoint: record.checkpoint, bundle },
      );
    } catch (error) {
      const backend = this.deps.registry.backendFor(replacement);
      await backend.destroy(replacement.reference).catch(() => {});
      this.deps.attachment.detach(record.sessionId, replacement.sandboxId);
      throw error;
    }
    await this.deps.store.set(replacement);
    transitions.add(1, { backend: record.backend, transition: "restore" });
    await this.deps.checkpoints.remove(record.sessionId);
    return client;
  }

  /**
   * The expired → gone transition: reclaim loudly while we still can name
   * the backend, so the next ensureRunning provisions fresh. A checkpointed
   * session has no sandbox left; only its record and bundle go.
   */
  private async reclaimExpired(
    record: HibernatedRecord | CheckpointedRecord,
  ): Promise<void> {
    if (record.state === "hibernated") {
      const backend = this.deps.registry.backendFor(record);
      await backend.destroy(record.reference);
      this.deps.attachment.drop(record.sandboxId);
    }
    await this.forgetSession(record.sessionId);
  }

  /** Drop the session record and everything derived from it. */
  private async forgetSession(sessionId: string): Promise<void> {
    await this.deps.store.delete(sessionId);
    // Unconditional: a crash between saving the bundle and writing the
    // checkpointed record leaves a bundle behind a running record.
    await this.deps.checkpoints.remove(sessionId);
    for (const hooks of this.hooks) {
      await hooks.afterRelease?.(sessionId);
    }
  }

  /** Only a session without a live sandbox carries a deadline. */
  private hasExpired(
    record: SessionRecord,
  ): record is HibernatedRecord | CheckpointedRecord {
    return (
      record.state !== "running" &&
      new Date(record.expiresAt).getTime() <= Date.now()
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
}

function orphanedRecordMessage(record: SessionRecord): string {
  return `session ${record.sessionId} has a ${record.backend} sandbox from profile ${record.profile}, which is no longer configured on that backend`;
}
