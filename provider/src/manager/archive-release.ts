import type { SandboxLifecycle } from "./sandbox-lifecycle.js";

/** The part of the host workspace registry the archive release reads. */
export interface WorkspaceArchiveSet {
  /** Sessions archived in the Web UI; dsh offers no unarchive, so the set only grows. */
  readonly archivedSessionIds: readonly string[];
}

export interface ArchiveReleaseDependencies {
  /** Settles once the host stores are loaded; a boot trigger waits for it. */
  ready(): Promise<void>;
  lifecycle: Pick<SandboxLifecycle, "records" | "release">;
  /** The host's archive set; absent outside the Web profile. */
  archivedSessionIds(): readonly string[];
  /** Whether a turn is open; release must not cut a live turn. */
  isTurnLive(sessionId: string): boolean;
  warn(message: string): void;
}

/**
 * Release sandboxes whose dsh session the user archived. Never rejects: it
 * runs from host events, and failures are warned so the next trigger — the
 * next workspace write, a turn/end, or boot — retries.
 */
export class ArchiveRelease {
  constructor(private readonly deps: ArchiveReleaseDependencies) {}

  /**
   * Destroy the sandbox and drop the record of every archived session.
   * Concurrent reconciles need no mutex: the engine's per-session lock
   * serializes the two release calls, and the second sees no record.
   */
  reconcile(): void {
    void this.reconcileArchived().catch((error) => {
      this.deps.warn(`could not release archived sandboxes: ${String(error)}`);
    });
  }

  private async reconcileArchived(): Promise<void> {
    // A boot trigger can fire before the stores have loaded; without this
    // wait, records() is empty and the previous run's archived sessions
    // survive until an unrelated trigger happens to fire.
    await this.deps.ready();
    const ids = new Set(this.deps.archivedSessionIds());
    // Records exist only for root sessions — subagent sessions share their
    // root's sandbox — so releasing the archived root releases the whole
    // subagent tree with it.
    await Promise.all(
      this.deps.lifecycle
        .records()
        .filter((record) => ids.has(record.sessionId))
        .map((record) =>
          this.deps.lifecycle.release(record.sessionId, () => {
            // Re-checked inside the session's lock; when it refuses, the
            // facade's turn/end trigger retries.
            return !this.deps.isTurnLive(record.sessionId);
          }),
        ),
    );
  }
}
