import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialBroker } from "../src/broker.js";
import { CheckpointHooks } from "../src/manager/checkpoint-hooks.js";
import type { CheckpointedRecord } from "../src/types.js";

const execute = promisify(execFile);

describe("checkpoint hooks", () => {
  let directory: string;
  let origin: string;
  let hooks: CheckpointHooks;
  const warnings: string[] = [];
  const ref = "dsh/wip/0123456789abcdef";

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execute("git", args, { cwd });
    return stdout;
  }

  function record(repositoryUrl: string): CheckpointedRecord {
    return {
      sessionId: "session-one",
      backend: "fake",
      profile: "standard",
      repositoryUrl,
      state: "checkpointed",
      checkpoint: {
        ref,
        commit: "0123456789abcdef0123456789abcdef01234567",
        committed: false,
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-checkpoint-hooks-"));
    origin = join(directory, "origin.git");
    const work = join(directory, "work");
    await git(directory, "init", "-q", "--bare", "-b", "main", origin);
    await git(directory, "clone", "-q", origin, work);
    await writeFile(join(work, "README.md"), "hello\n");
    await git(work, "add", "-A");
    await git(
      work,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@localhost",
      "commit",
      "-q",
      "-m",
      "init",
    );
    await git(work, "push", "-q", "origin", `HEAD:refs/heads/${ref}`);
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    warnings.length = 0;
    hooks = new CheckpointHooks({
      broker,
      warn: (message) => warnings.push(message),
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("deletes the remote branch when a checkpointed session is released", async () => {
    await hooks.afterRelease(record(origin));
    expect(await git(origin, "branch", "--list", ref)).toBe("");
    expect(warnings).toEqual([]);
  });

  it("only warns when the remote cannot be reached", async () => {
    await hooks.afterRelease(record(join(directory, "missing.git")));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not delete checkpoint branch/);
    expect(await git(origin, "branch", "--list", ref)).not.toBe("");
  });
});
