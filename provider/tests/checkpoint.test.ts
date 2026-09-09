import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseSaveOutput,
  RESTORE_SCRIPT,
  restoreEnvironment,
  SAVE_SCRIPT,
  type SavedCheckpoint,
} from "../src/checkpoint.js";
import { IdleSchedule } from "../src/manager/idle.js";
import { sleep } from "./fakes.js";

const execute = promisify(execFile);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const encode = (text: string) => new TextEncoder().encode(text);
const BUNDLE = encode("# v2 git bundle\nobjects");

describe("checkpoint", () => {
  it("reads the branch and commit lines the save script prints, then the bundle", () => {
    const output = new Uint8Array([
      ...encode(`feature\n${COMMIT}\n`),
      ...BUNDLE,
    ]);
    const saved = parseSaveOutput(output);
    expect(saved.checkpoint).toEqual({ commit: COMMIT, branch: "feature" });
    expect(new Uint8Array(saved.bundle)).toEqual(BUNDLE);
    const bare = parseSaveOutput(encode(`\n${COMMIT}\n`));
    expect(bare.checkpoint).toEqual({ commit: COMMIT });
    expect(bare.bundle.byteLength).toBe(0);
    expect(() => parseSaveOutput(encode("garbage"))).toThrow(
      /unexpected checkpoint output/,
    );
    expect(() => parseSaveOutput(encode("feature\nHEAD\n"))).toThrow(
      /unexpected checkpoint output/,
    );
    expect(() =>
      parseSaveOutput(encode(`feature\n${COMMIT}\nnot a bundle`)),
    ).toThrow(/unexpected checkpoint output/);
  });

  it("hands the restore script everything it reads", () => {
    const env = restoreEnvironment(
      { commit: COMMIT, branch: "feature" },
      BUNDLE,
    );
    expect(env).toEqual({
      DSH_CHECKPOINT_COMMIT: COMMIT,
      DSH_CHECKPOINT_BRANCH: "feature",
      DSH_CHECKPOINT_HAS_BUNDLE: "1",
    });
    expect(
      restoreEnvironment({ commit: COMMIT }, new Uint8Array()),
    ).toMatchObject({
      DSH_CHECKPOINT_BRANCH: "",
      DSH_CHECKPOINT_HAS_BUNDLE: "0",
    });
    for (const name of Object.keys(env)) {
      expect(RESTORE_SCRIPT).toContain(`$${name}`);
    }
  });
});

/**
 * The scripts against real git: a bare "origin", a clone standing in for the
 * sandbox workspace, and a second clone standing in for its replacement. The
 * bundle travels between them through memory, as it does through the host.
 */
describe("checkpoint scripts", () => {
  let directory: string;
  let origin: string;
  let work: string;
  let replacement: string;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execute("git", args, { cwd });
    return stdout;
  }

  async function save(cwd: string): Promise<SavedCheckpoint> {
    const { stdout } = await execute("/bin/bash", ["-c", SAVE_SCRIPT], {
      cwd,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseSaveOutput(stdout);
  }

  function restore(cwd: string, saved: SavedCheckpoint): Promise<unknown> {
    const child = execFile("/bin/bash", ["-c", RESTORE_SCRIPT], {
      cwd,
      env: {
        ...process.env,
        ...restoreEnvironment(saved.checkpoint, saved.bundle),
      },
    });
    const done = new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(undefined)
          : reject(new Error(`restore exited ${code}: ${stderr}`)),
      );
    });
    child.stdin?.end(saved.bundle);
    return done;
  }

  async function status(cwd: string): Promise<string[]> {
    const output = await git(cwd, "status", "--porcelain");
    return output.split("\n").filter(Boolean).sort();
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-checkpoint-"));
    origin = join(directory, "origin.git");
    work = join(directory, "work");
    replacement = join(directory, "replacement");
    await git(directory, "init", "-q", "--bare", "-b", "main", origin);
    await git(directory, "clone", "-q", origin, work);
    await git(work, "config", "user.name", "test");
    await git(work, "config", "user.email", "test@localhost");
    await writeFile(join(work, "README.md"), "hello\n");
    await writeFile(join(work, ".gitignore"), "ignored.txt\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-q", "-m", "init");
    await git(work, "push", "-q", "origin", "HEAD:main");
    // A clone of a populated repository has origin/HEAD; this one was cloned
    // while origin was still empty.
    await git(work, "remote", "set-head", "origin", "--auto");
    await git(work, "checkout", "-q", "-b", "feature");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips unpushed commits and every non-ignored change, staged or not", async () => {
    await writeFile(join(work, "lib.ts"), "export const lib = 1;\n");
    await git(work, "add", "lib.ts");
    await git(work, "commit", "-q", "-m", "add lib");
    const local = (await git(work, "rev-parse", "HEAD")).trim();
    await writeFile(join(work, "README.md"), "hello\nchanged\n");
    await writeFile(join(work, "new.ts"), "export {};\n");
    await writeFile(join(work, "ignored.txt"), "not tracked\n");
    await writeFile(join(work, ".env"), "LOCAL_SETTING=1\n");

    const saved = await save(work);
    expect(saved.checkpoint.branch).toBe("feature");
    expect(saved.checkpoint.commit).not.toBe(local);
    expect(saved.bundle.byteLength).toBeGreaterThan(0);
    // Nothing reached the remote.
    expect(await git(origin, "branch", "--list")).toBe("* main\n");

    await git(directory, "clone", "-q", origin, replacement);
    await restore(replacement, saved);

    expect(
      (await git(replacement, "symbolic-ref", "--short", "HEAD")).trim(),
    ).toBe("feature");
    expect((await git(replacement, "rev-parse", "HEAD")).trim()).toBe(local);
    expect(await status(replacement)).toEqual([
      " M README.md",
      "?? .env",
      "?? new.ts",
    ]);
  });

  it("needs no bundle for a clean detached HEAD the remote already has", async () => {
    await git(work, "checkout", "-q", "--detach", "main");
    const saved = await save(work);
    expect(saved.checkpoint).toEqual({
      commit: (await git(work, "rev-parse", "HEAD")).trim(),
    });
    expect(saved.bundle.byteLength).toBe(0);

    await git(directory, "clone", "-q", origin, replacement);
    await restore(replacement, saved);
    await expect(
      git(replacement, "symbolic-ref", "--quiet", "HEAD"),
    ).rejects.toThrow();
    expect(await status(replacement)).toEqual([]);
  });

  it("falls back to a self-contained bundle without origin/HEAD", async () => {
    await git(work, "remote", "set-head", "origin", "--delete");
    await writeFile(join(work, "new.ts"), "export {};\n");
    const saved = await save(work);
    expect(saved.bundle.byteLength).toBeGreaterThan(0);

    await git(directory, "clone", "-q", origin, replacement);
    await restore(replacement, saved);
    expect(await status(replacement)).toEqual(["?? new.ts"]);
  });

  it("does not stack a second checkpoint commit when a save is retried", async () => {
    await writeFile(join(work, "README.md"), "hello\nchanged\n");
    const first = await save(work);
    await writeFile(join(work, "later.ts"), "export {};\n");
    const second = await save(work);

    expect(second.checkpoint.commit).not.toBe(first.checkpoint.commit);
    expect((await git(work, "rev-list", "--count", "HEAD")).trim()).toBe("2");

    await git(directory, "clone", "-q", origin, replacement);
    await restore(replacement, second);
    expect(await status(replacement)).toEqual([" M README.md", "?? later.ts"]);
  });

  it("refuses to restore a commit the bundle did not bring", async () => {
    await git(directory, "clone", "-q", origin, replacement);
    await expect(
      restore(replacement, {
        checkpoint: { commit: COMMIT, branch: "feature" },
        bundle: new Uint8Array(),
      }),
    ).rejects.toThrow(/restore exited 1/);
    expect(
      (await git(replacement, "symbolic-ref", "--short", "HEAD")).trim(),
    ).toBe("main");
    expect(await status(replacement)).toEqual([]);
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
        throw new Error("bundle too large");
      },
      warn: (message) => warnings.push(message),
    });
    idle.schedule("session-one");
    await sleep(40);
    idle.dispose();
    expect(attempts).toBeGreaterThan(1);
    expect(warnings[0]).toMatch(
      /could not suspend session-one.*bundle too large/,
    );
  });
});
