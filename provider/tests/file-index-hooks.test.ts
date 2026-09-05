import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

describe("file index at hibernation", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("saves a file index at hibernation and drops it with the session", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    manager.indexFilesOnHibernate({
      excludedDirectories: ["node_modules"],
      maxEntries: 10,
    });
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;
    const indexPath = join(directory, "file-index", "session-one.json");

    // A running session has no saved index: the runner answers directly.
    await manager.ensureRunning(agent);
    expect(await manager.hibernatedFileIndex(agent)).toBeUndefined();
    expect(backend.client.treeRequests).toEqual([]);

    // Hibernation walks the workspace once, with the file-reference options,
    // and the saved index answers while the sandbox stays suspended.
    await manager.hibernate("session-one");
    expect(backend.client.treeRequests).toEqual([
      {
        path: "/workspace/repository",
        excludedDirectories: ["node_modules"],
        maxEntries: 10n,
      },
    ]);
    expect(await manager.hibernatedFileIndex(agent)).toEqual({
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/index.ts", kind: "file" },
      ],
      truncated: false,
    });
    expect(backend.wakes).toBe(0);
    await expect(stat(indexPath)).resolves.toBeDefined();

    // Once awake the index is stale by definition, so it is not offered.
    await manager.ensureRunning(agent);
    expect(backend.wakes).toBe(1);
    expect(await manager.hibernatedFileIndex(agent)).toBeUndefined();

    // Releasing the session removes its index file too.
    await manager.hibernate("session-one");
    await expect(stat(indexPath)).resolves.toBeDefined();
    await manager.release("session-one");
    await expect(stat(indexPath)).rejects.toThrow();
  });
});
