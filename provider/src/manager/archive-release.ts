import type { SandboxLifecycle } from "./sandbox-lifecycle.js";

/** The part of the host workspace registry the archive release reads. */
export interface WorkspaceArchiveSet {
  /** Sessions archived in the Web UI; dsh offers no unarchive, so the set only grows. */
  readonly archivedSessionIds: readonly string[];
}

/** The one dsh subagent-runtime call the archive release needs. */
export interface SubagentsLike {
  listDescendants(rootSessionId: string): Promise<Array<{ id: string }>>;
}

export interface ArchiveReleaseDependencies {
  /** Settles once the host stores are loaded; a boot trigger waits for it. */
  ready(): Promise<void>;
  lifecycle: Pick<SandboxLifecycle, "records" | "release">;
  /** The host's archive set; absent outside the Web profile. */
  archivedSessionIds(): readonly string[];
  /** Resolves the dsh subagent tree under one root; absent without delegation. */
  subagents(): SubagentsLike | undefined;
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
    // Every recorded session the archive set covers, plus its subagent tree.
    const doomed = new Set(
      this.deps.lifecycle
        .records()
        .filter((record) => ids.has(record.sessionId))
        .map((record) => record.sessionId),
    );
    for (const id of doomed) {
      // listDescendants returns the whole tree, so one call per root is enough.
      for (const child of await this.archivedDescendants(id)) {
        doomed.add(child);
      }
    }
    await Promise.all(
      this.deps.lifecycle
        .records()
        .filter((record) => doomed.has(record.sessionId))
        .map((record) =>
          this.deps.lifecycle.release(record.sessionId, () => {
            // Re-checked inside the session's lock; when it refuses, the
            // facade's turn/end trigger retries.
            return !this.deps.isTurnLive(record.sessionId);
          }),
        ),
    );
  }

  /**
   * Subagent session ids below one archived root, best-effort. Interim
   * bridge, not a design statement: dsh's archive is a display filter with no
   * lifecycle hook, and it cascades to nothing, while the sidebar hides
   * subagent-origin sessions — so once a root is archived, its children's
   * sandboxes are unreachable and can never be archived by hand; they would
   * sit out expiresAfterMs as dead storage. When dsh grows an archive hook
   * (or cascades itself, or surfaces hidden sessions), delete this walk and
   * its wiring in the facade.
   */
  private async archivedDescendants(rootId: string): Promise<string[]> {
    const subagents = this.deps.subagents();
    if (subagents === undefined) {
      return [];
    }
    try {
      const tree = await subagents.listDescendants(rootId);
      return tree.map((entry) => entry.id);
    } catch (error) {
      // The parent-only release still runs; children still expire.
      this.deps.warn(
        `could not list subagents under ${rootId}: ${String(error)}`,
      );
      return [];
    }
  }
}
