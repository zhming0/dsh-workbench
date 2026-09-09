import type { Session } from "@deepseek-ai/dsh-session";

import { CheckpointFailedError } from "../types.js";

/** What the idle controller needs from the lifecycle. */
export interface IdleScheduleHooks {
  /** Delay after the last activity before a session may suspend. */
  idleMs: number;
  /**
   * Failed checkpoint saves in a row a session may sit through before the
   * controller stops retrying and releases its sandbox. A backend that can
   * hibernate never reaches this: its failures park the sandbox instead of
   * keeping it running, so they stay free to retry.
   */
  maxCheckpointFailures: number;
  /** Settles once the host stores are loaded. */
  ready(): Promise<void>;
  /**
   * Suspend the session under its lock. The guard re-checks the idle
   * conditions inside that lock; when it refuses, nothing changes and
   * hibernate answers false. A failure on the checkpoint path rejects with
   * `CheckpointFailedError`; every other failure is untyped.
   */
  hibernate(sessionId: string, guard?: () => boolean): Promise<boolean>;
  /** A suspend attempt failed and will be retried after another idle delay. */
  warn(message: string): void;
  /** The last allowed checkpoint attempt failed and the sandbox is given up. */
  error(message: string): void;
  /** Destroy the sandbox and drop the session's record. */
  release(sessionId: string): Promise<void>;
}

/**
 * One idle countdown per session. `markActive` cancels an armed countdown and
 * every wake re-arms one, so a running record always carries a timer — a
 * session that was created but never got a turn still suspends.
 *
 * A live turn holds no countdown of its own: `beginTurn`/`endTurn` track
 * sessions whose turn is open on the session log (dsh-session pairs every
 * turn/start with a turn/end; repair synthesizes one after a crash). Turns
 * are counted per key, not flagged: a subagent shares its root session's
 * sandbox, so a parent turn and a child turn arrive under the same key and
 * overlap freely — the key stays live until the last open turn closes, and a
 * child's turn/end must not suspend the parent mid-generation. The activity
 * counter is silent during a single long generation, so live-turn tracking is
 * the only signal that suspending would cut a live turn. Rare — a generation
 * has to outlast idleMs — but a mid-stream suspend fails the whole turn, so
 * the cheap check is worth keeping.
 *
 * Failed checkpoint saves are counted per session: under
 * `maxCheckpointFailures` the countdown re-arms and the sandbox stays up;
 * at the cap the sandbox is released and the session dropped.
 */
export class IdleSchedule {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly activity = new Map<string, number>();
  private readonly liveTurns = new Map<string, number>();
  /** Consecutive failed checkpoint saves, per session. */
  private readonly failedSaves = new Map<string, number>();

  constructor(private readonly hooks: IdleScheduleHooks) {}

  /** A session just did something: cancel its countdown and note activity. */
  markActive(sessionId: string): void {
    this.cancel(sessionId);
    this.activity.set(sessionId, (this.activity.get(sessionId) ?? 0) + 1);
    // The session is in use again; whatever made the save fail may have been
    // fixed, so it earns a full budget of attempts back.
    this.failedSaves.delete(sessionId);
  }

  /** Arm, or re-arm at the current activity level, the session's countdown. */
  schedule(session: Session | string): void {
    const sessionId =
      typeof session === "string" ? session : String(session.id);
    this.cancel(sessionId);
    const activity = this.activity.get(sessionId) ?? 0;
    const timer = setTimeout(
      () =>
        void this.tick(sessionId, activity).catch((error: unknown) => {
          // Say so: a suspend that keeps failing would otherwise leave the
          // sandbox running in silence.
          this.hooks.warn(
            `could not suspend ${sessionId}, retrying after the idle delay: ${error instanceof Error ? error.message : String(error)}`,
          );
          if ((this.activity.get(sessionId) ?? 0) === activity) {
            this.schedule(sessionId);
          }
        }),
      this.hooks.idleMs,
    );
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  /** A turn is running; the session must not suspend under it. */
  beginTurn(sessionId: string): void {
    this.liveTurns.set(sessionId, (this.liveTurns.get(sessionId) ?? 0) + 1);
  }

  /** A turn closed: endTurn re-arms, so the session suspends once idle. */
  endTurn(session: Session | string): void {
    const sessionId =
      typeof session === "string" ? session : String(session.id);
    const remaining = (this.liveTurns.get(sessionId) ?? 0) - 1;
    if (remaining <= 0) {
      this.liveTurns.delete(sessionId);
    } else {
      this.liveTurns.set(sessionId, remaining);
    }
    this.schedule(sessionId);
  }

  /** Whether a turn is open; release paths must not cut a live turn. */
  isTurnLive(sessionId: string): boolean {
    return (this.liveTurns.get(sessionId) ?? 0) > 0;
  }

  /** Cancel every armed countdown; the host is going down. */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private async tick(
    sessionId: string,
    expectedActivity: number,
  ): Promise<void> {
    await this.hooks.ready();
    try {
      const suspended = await this.hooks.hibernate(sessionId, () => {
        const stillIdle =
          (this.activity.get(sessionId) ?? 0) === expectedActivity;
        return stillIdle && !this.liveTurns.has(sessionId);
      });
      if (suspended) {
        this.failedSaves.delete(sessionId);
      } else if (this.liveTurns.has(sessionId)) {
        // A live turn holds no countdown of its own: retry until the matching
        // endTurn re-arms. (An activity change means a wake is in flight, and
        // its ensureRunning re-arms instead.)
        this.schedule(sessionId);
      }
    } catch (error) {
      if (!(error instanceof CheckpointFailedError)) {
        throw error;
      }
      await this.afterCheckpointFailure(sessionId, error, expectedActivity);
    }
  }

  /**
   * Count one failed checkpoint save. Under the cap, warn and try again
   * after the idle delay. At the cap, stop paying for a sandbox whose work
   * cannot be saved: release it and drop the session, which is what idle did
   * before checkpointing existed. A failed release leaves the countdown to
   * the caller's catch, so the whole cycle retries later.
   */
  private async afterCheckpointFailure(
    sessionId: string,
    error: CheckpointFailedError,
    expectedActivity: number,
  ): Promise<void> {
    const failures = (this.failedSaves.get(sessionId) ?? 0) + 1;
    if (failures < this.hooks.maxCheckpointFailures) {
      this.failedSaves.set(sessionId, failures);
      this.hooks.warn(
        `could not checkpoint ${sessionId} (${failures} of ${this.hooks.maxCheckpointFailures}), retrying after the idle delay: ${error.message}`,
      );
      if ((this.activity.get(sessionId) ?? 0) === expectedActivity) {
        this.schedule(sessionId);
      }
      return;
    }
    this.failedSaves.delete(sessionId);
    this.hooks.error(
      `could not checkpoint ${sessionId} (${failures} failed saves); releasing the sandbox and dropping the session, which loses any work that was not pushed: ${error.message}`,
    );
    await this.hooks.release(sessionId);
  }

  private cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.timers.delete(sessionId);
  }
}
