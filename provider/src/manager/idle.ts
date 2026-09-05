import type { Session } from "@deepseek-ai/dsh-session";

/** What the idle controller needs from the lifecycle. */
export interface IdleScheduleHooks {
  /** Delay after the last activity before a session may suspend. */
  idleMs: number;
  /** Settles once the host stores are loaded. */
  ready(): Promise<void>;
  /**
   * Suspend the session under its lock. The guard re-checks the idle
   * conditions inside that lock; when it refuses, nothing changes and
   * hibernate answers false.
   */
  hibernate(sessionId: string, guard?: () => boolean): Promise<boolean>;
}

/**
 * One idle countdown per session. `markActive` cancels an armed countdown and
 * every wake re-arms one, so a running record always carries a timer — a
 * session that was created but never got a turn still suspends.
 *
 * A live turn holds no countdown of its own: `beginTurn`/`endTurn` track
 * sessions whose turn is open on the session log (dsh-session pairs every
 * turn/start with a turn/end; repair synthesizes one after a crash). The
 * activity counter is silent during a single long generation, so live-turn
 * tracking is the only signal that suspending would cut a live turn. Rare —
 * a generation has to outlast idleMs — but a mid-stream suspend fails the
 * whole turn, so the cheap check is worth keeping.
 */
export class IdleSchedule {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly activity = new Map<string, number>();
  private readonly liveTurns = new Set<string>();

  constructor(private readonly hooks: IdleScheduleHooks) {}

  /** A session just did something: cancel its countdown and note activity. */
  markActive(sessionId: string): void {
    this.cancel(sessionId);
    this.activity.set(sessionId, (this.activity.get(sessionId) ?? 0) + 1);
  }

  /** Arm, or re-arm at the current activity level, the session's countdown. */
  schedule(session: Session | string): void {
    const sessionId =
      typeof session === "string" ? session : String(session.id);
    this.cancel(sessionId);
    const activity = this.activity.get(sessionId) ?? 0;
    const timer = setTimeout(
      () =>
        void this.tick(sessionId, activity).catch(() => {
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
    this.liveTurns.add(sessionId);
  }

  /** A turn closed: endTurn re-arms, so the session suspends once idle. */
  endTurn(session: Session | string): void {
    const sessionId =
      typeof session === "string" ? session : String(session.id);
    this.liveTurns.delete(sessionId);
    this.schedule(sessionId);
  }

  /** Whether a turn is open; release paths must not cut a live turn. */
  isTurnLive(sessionId: string): boolean {
    return this.liveTurns.has(sessionId);
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
    const suspended = await this.hooks.hibernate(sessionId, () => {
      const stillIdle =
        (this.activity.get(sessionId) ?? 0) === expectedActivity;
      return stillIdle && !this.liveTurns.has(sessionId);
    });
    if (!suspended && this.liveTurns.has(sessionId)) {
      // A live turn holds no countdown of its own: retry until the matching
      // endTurn re-arms. (An activity change means a wake is in flight, and
      // its ensureRunning re-arms instead.)
      this.schedule(sessionId);
    }
  }

  private cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.timers.delete(sessionId);
  }
}
