import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkpointRef,
  deleteCheckpointBranch,
  parseSaveOutput,
  RESTORE_SCRIPT,
  restoreEnvironment,
  SAVE_SCRIPT,
} from "../src/checkpoint.js";
import { IdleSchedule } from "../src/manager/idle.js";
import { sleep } from "./fakes.js";

const execute = promisify(execFile);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("checkpoint", () => {
  it("derives one stable branch per session", () => {
    expect(checkpointRef("session-one")).toBe(checkpointRef("session-one"));
    expect(checkpointRef("session-one")).not.toBe(checkpointRef("session-two"));
    expect(checkpointRef("session-one")).toMatch(/^dsh\/wip\/[0-9a-f]{16}$/);
  });

  it("reads the branch, commit flag, and commit the save script prints", () => {
    expect(parseSaveOutput("dsh/wip/x", `feature\n1\n${COMMIT}\n`)).toEqual({
      ref: "dsh/wip/x",
      commit: COMMIT,
      branch: "feature",
      committed: true,
    });
    expect(parseSaveOutput("dsh/wip/x", `\n0\n${COMMIT}\n`)).toEqual({
      ref: "dsh/wip/x",
      commit: COMMIT,
      committed: false,
    });
    expect(() => parseSaveOutput("dsh/wip/x", "garbage")).toThrow(
      /unexpected checkpoint output/,
    );
    expect(() => parseSaveOutput("dsh/wip/x", "feature\n1\nHEAD\n")).toThrow(
      /unexpected checkpoint output/,
    );
  });

  it("hands the restore script everything it reads", () => {
    const env = restoreEnvironment({
      ref: "dsh/wip/x",
      commit: COMMIT,
      branch: "feature",
      committed: true,
    });
    expect(env).toEqual({
      DSH_CHECKPOINT_REF: "dsh/wip/x",
      DSH_CHECKPOINT_COMMIT: COMMIT,
      DSH_CHECKPOINT_BRANCH: "feature",
      DSH_CHECKPOINT_COMMITTED: "1",
    });
    for (const name of Object.keys(env)) {
      expect(RESTORE_SCRIPT).toContain(`$${name}`);
    }
    expect(SAVE_SCRIPT).toContain("$DSH_CHECKPOINT_REF");
  });
});

/**
 * The scripts against real git: a bare "origin", a clone standing in for the
 * sandbox workspace, and a second clone standing in for its replacement.
 */
describe("checkpoint scripts", () => {
  let directory: string;
  let origin: string;
  let work: string;
  const ref = "dsh/wip/0123456789abcdef";

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execute("git", args, { cwd });
    return stdout;
  }

  async function run(
    cwd: string,
    script: string,
    env: Record<string, string>,
  ): Promise<string> {
    const { stdout } = await execute("/bin/bash", ["-c", script], {
      cwd,
      env: { ...process.env, ...env },
    });
    return stdout;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-checkpoint-"));
    origin = join(directory, "origin.git");
    work = join(directory, "work");
    await git(directory, "init", "-q", "--bare", "-b", "main", origin);
    await git(directory, "clone", "-q", origin, work);
    await git(work, "config", "user.name", "test");
    await git(work, "config", "user.email", "test@localhost");
    await writeFile(join(work, "README.md"), "hello\n");
    await writeFile(join(work, ".gitignore"), "ignored.txt\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "init");
    await git(work, "push", "-q", "origin", "HEAD:main");
    await git(work, "checkout", "-q", "-b", "feature");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips staged, unstaged, and untracked changes but never secrets", async () => {
    await writeFile(join(work, "README.md"), "hello\nchanged\n");
    await writeFile(join(work, "new.ts"), "export {};\n");
    await writeFile(join(work, "ignored.txt"), "not tracked\n");
    await writeFile(join(work, ".env"), "TOKEN=hunter2\n");
    await writeFile(join(work, "deploy.pem"), "-----BEGIN-----\n");
    await writeFile(join(work, "env.ts"), "export const env = 1;\n");

    const output = await run(work, SAVE_SCRIPT, { DSH_CHECKPOINT_REF: ref });
    const checkpoint = parseSaveOutput(ref, output);
    expect(checkpoint).toMatchObject({
      ref,
      branch: "feature",
      committed: true,
    });
    const pushed = await git(origin, "ls-tree", "--name-only", ref);
    expect(pushed.split("\n").filter(Boolean).sort()).toEqual([
      ".gitignore",
      "README.md",
      "env.ts",
      "new.ts",
    ]);

    const replacement = join(directory, "replacement");
    await git(directory, "clone", "-q", origin, replacement);
    await git(replacement, "checkout", "-q", ref);
    await run(replacement, RESTORE_SCRIPT, restoreEnvironment(checkpoint));

    expect(
      (await git(replacement, "symbolic-ref", "--short", "HEAD")).trim(),
    ).toBe("feature");
    const status = await git(replacement, "status", "--porcelain");
    expect(status.split("\n").filter(Boolean).sort()).toEqual([
      " M README.md",
      "?? env.ts",
      "?? new.ts",
    ]);
    expect(await git(origin, "branch", "--list", ref)).toBe("");
  });

  it("refuses to restore when HEAD is not the checkpoint commit", async () => {
    const replacement = join(directory, "replacement");
    await git(directory, "clone", "-q", origin, replacement);
    await expect(
      run(
        replacement,
        RESTORE_SCRIPT,
        restoreEnvironment({ ref, commit: COMMIT, committed: true }),
      ),
    ).rejects.toThrow(/not at checkpoint/);
    expect(await git(replacement, "status", "--porcelain")).toBe("");
  });

  it("deletes a checkpoint branch from the host", async () => {
    await git(work, "push", "-q", "origin", `HEAD:refs/heads/${ref}`);
    expect(await git(origin, "branch", "--list", ref)).not.toBe("");
    await deleteCheckpointBranch(origin, ref, undefined);
    expect(await git(origin, "branch", "--list", ref)).toBe("");
  });
});

describe("idle schedule", () => {
  it("warns and re-arms when a suspend attempt fails", async () => {
    const warnings: string[] = [];
    let attempts = 0;
    const idle = new IdleSchedule({
      idleMs: 5,
      ready: async () => {},
      hibernate: async () => {
        attempts += 1;
        throw new Error("push rejected");
      },
      warn: (message) => warnings.push(message),
    });
    idle.schedule("session-one");
    await sleep(40);
    idle.dispose();
    expect(attempts).toBeGreaterThan(1);
    expect(warnings[0]).toMatch(/could not suspend session-one.*push rejected/);
  });
});
