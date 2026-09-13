import { sleep } from "./fakes.js";
import { ArchiveRelease } from "../src/manager/archive-release.js";
import type { SandboxLifecycle } from "../src/manager/sandbox-lifecycle.js";
import type { SessionRecord } from "../src/types.js";
import { describe, expect, it } from "vitest";

function record(sessionId: string): SessionRecord {
  return {
    sessionId,
    backend: "fake",
    profile: "standard",
    sandboxId: `sandbox-${sessionId}`,
    reference: { id: sessionId },
    repositoryUrl: "https://github.com/example/public",
    state: "hibernated",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Stands in for the engine: honors the guard contract the real release
 * follows (refuse changes nothing, accept drops the record).
 */
function fakeLifecycle(records: SessionRecord[]) {
  const pool = [...records];
  const released: string[] = [];
  const lifecycle: Pick<SandboxLifecycle, "records" | "release"> = {
    records: () => pool,
    release: async (sessionId, guard) => {
      if (guard !== undefined && !guard()) {
        return;
      }
      released.push(sessionId);
      pool.splice(
        pool.findIndex((item) => item.sessionId === sessionId),
        1,
      );
    },
  };
  return { lifecycle, released };
}

interface ArchiveReleaseOptions {
  archivedSessionIds?: readonly string[];
  isTurnLive?: (sessionId: string) => boolean;
  ready?: Promise<void>;
  warnings?: string[];
}

function archiveRelease(
  lifecycle: Pick<SandboxLifecycle, "records" | "release">,
  options: ArchiveReleaseOptions = {},
) {
  return new ArchiveRelease({
    ready: () => options.ready ?? Promise.resolve(),
    lifecycle,
    archivedSessionIds: () => options.archivedSessionIds ?? [],
    isTurnLive: options.isTurnLive ?? (() => false),
    warn: (message) => options.warnings?.push(message),
  });
}

describe("ArchiveRelease", () => {
  it("releases the archived root session's sandbox", async () => {
    // Subagent sessions hold no sandbox record of their own, so the root is
    // the only record an archive ever releases.
    const { lifecycle, released } = fakeLifecycle([
      record("root"),
      record("unrelated"),
    ]);
    const archive = archiveRelease(lifecycle, {
      archivedSessionIds: ["root"],
    });

    archive.reconcile();
    await sleep(20);

    expect(released).toEqual(["root"]);
  });

  it("refuses to cut a live turn and releases once the turn closes", async () => {
    const { lifecycle, released } = fakeLifecycle([record("root")]);
    let turnLive = true;
    const archive = archiveRelease(lifecycle, {
      archivedSessionIds: ["root"],
      isTurnLive: () => turnLive,
    });

    archive.reconcile();
    await sleep(20);
    expect(released).toEqual([]);

    // turn/end flips the guard and the facade re-triggers the reconcile.
    turnLive = false;
    archive.reconcile();
    await sleep(20);
    expect(released).toEqual(["root"]);
  });

  it("waits for the stores before a boot reconcile reads them", async () => {
    let storesLoaded = () => {};
    const ready = new Promise<void>((resolve) => {
      storesLoaded = resolve;
    });
    const { lifecycle, released } = fakeLifecycle([record("root")]);
    const archive = archiveRelease(lifecycle, {
      archivedSessionIds: ["root"],
      ready,
    });

    // The boot trigger fires while the store is still loading: records() is
    // empty and nothing may be released yet.
    archive.reconcile();
    await sleep(20);
    expect(released).toEqual([]);

    storesLoaded();
    await sleep(20);
    expect(released).toEqual(["root"]);
  });
});
