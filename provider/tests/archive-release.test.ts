import { sleep } from "./fakes.js";
import {
  ArchiveRelease,
  type SubagentsLike,
} from "../src/manager/archive-release.js";
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
  subagents?: SubagentsLike;
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
    subagents: () => options.subagents,
    isTurnLive: options.isTurnLive ?? (() => false),
    warn: (message) => options.warnings?.push(message),
  });
}

describe("ArchiveRelease", () => {
  it("releases archived sessions and their subagent trees", async () => {
    const { lifecycle, released } = fakeLifecycle([
      record("root"),
      record("child"),
      record("unrelated"),
    ]);
    const archive = archiveRelease(lifecycle, {
      archivedSessionIds: ["root"],
      subagents: {
        listDescendants: async () => [{ id: "child" }],
      },
    });

    archive.reconcile();
    await sleep(20);

    expect(released).toEqual(["root", "child"]);
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

  it("still releases the parent when subagent discovery fails", async () => {
    const { lifecycle, released } = fakeLifecycle([
      record("root"),
      record("child"),
    ]);
    const warnings: string[] = [];
    const archive = archiveRelease(lifecycle, {
      archivedSessionIds: ["root"],
      subagents: {
        listDescendants: async () => {
          throw new Error("projections unavailable");
        },
      },
      warnings,
    });

    archive.reconcile();
    await sleep(20);

    expect(released).toEqual(["root"]);
    expect(warnings).toHaveLength(1);
  });

  it("releases the parent only when no delegation service is mounted", async () => {
    const { lifecycle, released } = fakeLifecycle([
      record("root"),
      record("child"),
    ]);
    const archive = archiveRelease(lifecycle, {
      archivedSessionIds: ["root"],
    });

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
