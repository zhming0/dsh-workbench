import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkpointRef,
  parseSaveOutput,
  RESTORE_SCRIPT,
  restoreEnvironment,
  SAVE_SCRIPT,
} from "../src/checkpoint.js";
import { IdleSchedule } from "../src/manager/idle.js";
import { SandboxManager } from "../src/manager/index.js";
import { SessionStore } from "../src/state-store.js";
import { FakeBackend, gatewayFor, sleep } from "./fakes.js";

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

describe("checkpoint lifecycle", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function manager(backend: FakeBackend, store: SessionStore) {
    backend.capabilities.supportsHibernate = false;
    return new SandboxManager(
      new Context(),
      {
        profiles: { ci: { backend: "docker" } },
        defaultProfile: "ci",
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        revision: "v1",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { ci: backend }, gateway: gatewayFor(backend), store },
    );
  }

  const agent = {
    id: "session-one",
    session: { header: {} },
  } as unknown as Agent;

  it("pushes the tree on idle and restores it into a new sandbox", async () => {
    const backend = new FakeBackend();
    const store = new SessionStore(join(directory, "sessions.json"));
    const sandboxes = manager(backend, store);
    const client = backend.client;

    await sandboxes.ensureRunning(agent);
    expect(client.setupRequests).toEqual([{ revision: "v1" }]);

    client.execReplies.push({ stdout: `feature\n1\n${COMMIT}\n` });
    await sandboxes.hibernate("session-one");

    const ref = checkpointRef("session-one");
    const checkpoint = {
      ref,
      commit: COMMIT,
      branch: "feature",
      committed: true,
    };
    expect(client.execs).toHaveLength(1);
    expect(client.execs[0]?.env).toEqual({ DSH_CHECKPOINT_REF: ref });
    expect(client.execs[0]?.cwd).toBe("/workspace/repository");
    expect(backend.hibernations).toBe(0);
    expect(backend.destroys).toBe(1);
    expect(backend.expiries).toBe(0);
    const record = store.get("session-one");
    expect(record?.state).toBe("hibernated");
    expect(record?.expiresAt).toBeDefined();
    expect(record?.checkpoint).toEqual(checkpoint);

    await sandboxes.ensureRunning(agent);
    expect(backend.wakes).toBe(0);
    expect(backend.provisions).toBe(2);
    expect(client.setupRequests[1]).toEqual({ revision: ref });
    expect(client.execs).toHaveLength(2);
    expect(client.execs[1]?.env).toEqual(restoreEnvironment(checkpoint));
    const resumed = store.get("session-one");
    expect(resumed?.state).toBe("running");
    expect(resumed?.checkpoint).toBeUndefined();
    expect(resumed?.expiresAt).toBeUndefined();
  });

  it("keeps the sandbox when the push fails", async () => {
    const backend = new FakeBackend();
    const store = new SessionStore(join(directory, "sessions.json"));
    const sandboxes = manager(backend, store);

    await sandboxes.ensureRunning(agent);
    backend.client.execReplies.push({ exitCode: 1 });
    await expect(sandboxes.hibernate("session-one")).rejects.toThrow(
      /checkpoint script failed with exit code 1/,
    );
    expect(backend.destroys).toBe(0);
    expect(backend.running).toBe(true);
    expect(store.get("session-one")?.state).toBe("running");
  });

  it("retries a failed restore on the next turn and keeps the checkpoint meanwhile", async () => {
    const backend = new FakeBackend();
    const store = new SessionStore(join(directory, "sessions.json"));
    const sandboxes = manager(backend, store);
    const client = backend.client;

    await sandboxes.ensureRunning(agent);
    client.execReplies.push({ stdout: `feature\n1\n${COMMIT}\n` });
    await sandboxes.hibernate("session-one");
    const checkpoint = store.get("session-one")?.checkpoint;

    // The restore script fails in the replacement sandbox.
    client.execReplies.push({ exitCode: 1 });
    await expect(sandboxes.ensureRunning(agent)).rejects.toThrow(
      /checkpoint script failed/,
    );
    expect(backend.provisions).toBe(2);
    expect(store.get("session-one")).toMatchObject({
      state: "running",
      checkpoint,
    });

    // Idle before any retry: nothing new to save, the pushed branch stands.
    await sandboxes.hibernate("session-one");
    expect(client.execs).toHaveLength(2);
    expect(backend.destroys).toBe(2);
    expect(store.get("session-one")).toMatchObject({
      state: "hibernated",
      checkpoint,
    });

    // The next turn provisions again and restores from the same checkpoint.
    await sandboxes.ensureRunning(agent);
    expect(backend.provisions).toBe(3);
    expect(client.setupRequests[2]).toEqual({ revision: checkpoint?.ref });
    expect(client.execs).toHaveLength(3);
    expect(client.execs[2]?.env.DSH_CHECKPOINT_COMMIT).toBe(COMMIT);
    expect(store.get("session-one")?.checkpoint).toBeUndefined();
  });

  it("drops the record when the sandbox vanished before the save", async () => {
    const backend = new FakeBackend();
    const store = new SessionStore(join(directory, "sessions.json"));
    const sandboxes = manager(backend, store);

    await sandboxes.ensureRunning(agent);
    // A host restart forgets the runner client; the build has since ended.
    backend.running = false;
    const restarted = manager(backend, store);
    await restarted.hibernate("session-one");
    expect(backend.client.execs).toHaveLength(0);
    expect(store.get("session-one")).toBeUndefined();
  });

  it("never touches the backend again for a checkpointed record", async () => {
    const backend = new FakeBackend();
    const store = new SessionStore(join(directory, "sessions.json"));
    const sandboxes = manager(backend, store);

    await sandboxes.ensureRunning(agent);
    backend.client.execReplies.push({ stdout: `\n0\n${COMMIT}\n` });
    await sandboxes.hibernate("session-one");
    expect(backend.destroys).toBe(1);

    // Boot: no deadline to set on a sandbox that no longer exists.
    const restarted = manager(backend, store);
    await restarted.getSessionProfile("session-one");
    expect(backend.expiries).toBe(0);
    expect(store.get("session-one")?.state).toBe("hibernated");

    // Expiry: the record goes, without a second destroy.
    const record = store.get("session-one");
    if (record === undefined) {
      throw new Error("record missing");
    }
    await store.set({ ...record, expiresAt: new Date(0).toISOString() });
    const expired = manager(backend, store);
    await expired.getSessionProfile("session-one");
    expect(store.get("session-one")).toBeUndefined();
    expect(backend.destroys).toBe(1);
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
