import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";

import { FileType } from "../src/gen/dsh/sandbox/v1/runner_pb.js";
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  SandboxFileReferenceService,
} from "../src/file-reference.js";
import type { RunnerClient } from "../src/runner-client.js";

interface FakeTreeEntry {
  relativePath: string;
  type: FileType;
}

function makeContext(entries: FakeTreeEntry[]) {
  const ctx = new Context();
  const treeCalls: { root: string; excludedDirectories: string[] }[] = [];
  const client = {
    tree: async (request: {
      path: string;
      excludedDirectories: string[];
      maxEntries: bigint;
    }) => {
      treeCalls.push({
        root: request.path,
        excludedDirectories: [...request.excludedDirectories],
      });
      return { entries, truncated: false };
    },
  } as unknown as RunnerClient;
  const sandboxManager = {
    workspace: "/workspace/repository",
    ensureRunning: async () => client,
    hibernatedFileIndex: async () => undefined,
    indexFilesOnHibernate: () => {},
  };
  const agents = {
    list: () => [],
    get: () => undefined,
  };
  ctx.provide("sandboxManager", sandboxManager);
  ctx.provide("agents", agents);
  return { ctx, client, treeCalls, agents };
}

function makeAgent(cwd: string, id = "session-one"): Agent {
  return {
    id,
    session: { id, header: { cwd } },
  } as unknown as Agent;
}

const HOST_CWD = "/data/.dsh-sandbox/workspace-anchors/repository-one";

const tree = (
  entries: FakeTreeEntry[],
): {
  service: SandboxFileReferenceService;
  treeCalls: { root: string; excludedDirectories: string[] }[];
  ctx: Context;
  agents: { list: () => unknown[]; get: (id: string) => unknown };
} => {
  const { ctx, treeCalls, agents } = makeContext(entries);
  const service = new SandboxFileReferenceService(ctx);
  return { service, treeCalls, ctx, agents };
};

describe("SandboxFileReferenceService", () => {
  it("lists the sandbox workspace root, translated from the host anchor", async () => {
    const { service, treeCalls } = tree([
      { relativePath: "src", type: FileType.DIRECTORY },
      { relativePath: "src/index.ts", type: FileType.REGULAR },
      { relativePath: "README.md", type: FileType.REGULAR },
    ]);
    const candidates = await service.list(
      makeAgent(HOST_CWD),
      "",
      new AbortController().signal,
    );
    expect(candidates).toEqual([
      { path: "src", kind: "directory" },
      { path: "README.md", kind: "file" },
    ]);
    // The listing walked the sandbox workspace, not the host anchor.
    expect(treeCalls).toEqual([
      {
        root: "/workspace/repository",
        excludedDirectories: [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES],
      },
    ]);
  });

  it("lists deeper directories relative to the workspace root", async () => {
    const { service } = tree([
      { relativePath: "src", type: FileType.DIRECTORY },
      { relativePath: "src/index.ts", type: FileType.REGULAR },
      { relativePath: "src/nested", type: FileType.DIRECTORY },
      { relativePath: "src/nested/deep.ts", type: FileType.REGULAR },
    ]);
    const candidates = await service.list(
      makeAgent(HOST_CWD),
      "src/",
      new AbortController().signal,
    );
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "src/nested",
      "src/index.ts",
    ]);
  });

  it("fuzzy-matches across the whole workspace for a bare query", async () => {
    const { service } = tree([
      { relativePath: "provider", type: FileType.DIRECTORY },
      { relativePath: "provider/package.json", type: FileType.REGULAR },
      { relativePath: "package.json", type: FileType.REGULAR },
    ]);
    const candidates = await service.list(
      makeAgent(HOST_CWD),
      "package",
      new AbortController().signal,
    );
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "package.json",
      "provider/package.json",
    ]);
  });

  it("hides dot entries from directory listings unless the query asks for them", async () => {
    const { service } = tree([
      { relativePath: ".github", type: FileType.DIRECTORY },
      { relativePath: ".github/workflows", type: FileType.DIRECTORY },
      { relativePath: "README.md", type: FileType.REGULAR },
    ]);
    const plain = await service.list(
      makeAgent(HOST_CWD),
      "",
      new AbortController().signal,
    );
    expect(plain.map((candidate) => candidate.path)).toEqual(["README.md"]);
    // A fuzzy query that itself names a dot lets dot paths through.
    const dotted = await service.list(
      makeAgent(HOST_CWD),
      ".g",
      new AbortController().signal,
    );
    expect(dotted.map((candidate) => candidate.path)).toEqual([
      ".github",
      ".github/workflows",
    ]);
  });

  it("forwards the excluded-directory list and ignores nothing extra", async () => {
    const { service, treeCalls } = tree([
      { relativePath: "node_modules", type: FileType.DIRECTORY },
      { relativePath: "node_modules/dep", type: FileType.DIRECTORY },
      { relativePath: "node_modules/dep/index.js", type: FileType.REGULAR },
    ]);
    await service.list(
      makeAgent(HOST_CWD),
      "dep",
      new AbortController().signal,
    );
    expect(treeCalls[0]?.excludedDirectories).toContain("node_modules");
    expect(treeCalls[0]?.excludedDirectories).toContain(".git");
    // The runner already prunes excluded subtrees, so nothing is offered.
    expect(treeCalls).toHaveLength(1);
  });

  it("refreshes the snapshot after a tool result invalidates it", async () => {
    const ctx = new Context();
    const agent = makeAgent(HOST_CWD);
    let entries: FakeTreeEntry[] = [
      { relativePath: "README.md", type: FileType.REGULAR },
    ];
    let treeCalls = 0;
    const sandboxManager = {
      workspace: "/workspace/repository",
      ensureRunning: async () =>
        ({
          tree: async () => {
            treeCalls += 1;
            return { entries, truncated: false };
          },
        }) as unknown as RunnerClient,
      hibernatedFileIndex: async () => undefined,
      indexFilesOnHibernate: () => {},
    };
    const agents = {
      list: () => [],
      get: (id: string) => (id === "session-one" ? agent : undefined),
    };
    ctx.provide("sandboxManager", sandboxManager);
    ctx.provide("agents", agents);
    const service = new SandboxFileReferenceService(ctx);

    const seed = await service.list(agent, "", new AbortController().signal);
    expect(seed.map((candidate) => candidate.path)).toEqual(["README.md"]);

    // A tool wrote a new file; the next directory listing sees it.
    entries = [
      { relativePath: "README.md", type: FileType.REGULAR },
      { relativePath: "NEW.md", type: FileType.REGULAR },
    ];
    const session = { id: "session-one" } as unknown as Session;
    ctx.emit("session/event", session, {
      type: "tool/result",
    } as unknown as SessionEvent);
    // The walk waits for a query instead of following every tool result.
    expect(treeCalls).toBe(1);
    const after = await service.list(agent, "", new AbortController().signal);
    expect(after.map((candidate) => candidate.path)).toEqual([
      "NEW.md",
      "README.md",
    ]);
    expect(treeCalls).toBe(2);
  });

  it("answers for a hibernated session from the saved index without waking it", async () => {
    const ctx = new Context();
    const agent = makeAgent(HOST_CWD);
    let wakes = 0;
    const sandboxManager = {
      workspace: "/workspace/repository",
      ensureRunning: async () => {
        wakes += 1;
        throw new Error("a hibernated session must not wake for @");
      },
      hibernatedFileIndex: async () => ({
        entries: [
          { path: "src", kind: "directory" as const },
          { path: "src/index.ts", kind: "file" as const },
          { path: "README.md", kind: "file" as const },
        ],
        truncated: false,
      }),
      indexFilesOnHibernate: () => {},
    };
    ctx.provide("sandboxManager", sandboxManager);
    ctx.provide("agents", { list: () => [], get: () => undefined });
    const service = new SandboxFileReferenceService(ctx);

    const root = await service.list(agent, "", new AbortController().signal);
    expect(root).toEqual([
      { path: "src", kind: "directory" },
      { path: "README.md", kind: "file" },
    ]);
    const nested = await service.list(
      agent,
      "src/",
      new AbortController().signal,
    );
    expect(nested.map((candidate) => candidate.path)).toEqual(["src/index.ts"]);
    expect(wakes).toBe(0);
  });

  it("hands its exclusions and entry cap to the manager for hibernation", () => {
    const ctx = new Context();
    let received: unknown;
    ctx.provide("sandboxManager", {
      workspace: "/workspace/repository",
      ensureRunning: async () => undefined,
      hibernatedFileIndex: async () => undefined,
      indexFilesOnHibernate: (options: unknown) => {
        received = options;
      },
    });
    ctx.provide("agents", { list: () => [], get: () => undefined });
    new SandboxFileReferenceService(ctx, {
      maxEntries: 7,
      excludedDirectories: ["vendor"],
    });
    expect(received).toEqual({
      excludedDirectories: ["vendor"],
      maxEntries: 7,
    });
  });
});
