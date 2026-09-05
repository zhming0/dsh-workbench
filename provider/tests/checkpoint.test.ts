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
import { SandboxManager } from "../src/manager.js";
import { SessionStore } from "../src/state-store.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

describe("checkpoint", () => {
  it("derives one stable branch per session", () => {
    expect(checkpointRef("session-one")).toBe(checkpointRef("session-one"));
    expect(checkpointRef("session-one")).not.toBe(checkpointRef("session-two"));
    expect(checkpointRef("session-one")).toMatch(/^dsh\/wip\/[0-9a-f]{16}$/);
  });

  it("reads the branch and commit flag the save script prints", () => {
    expect(parseSaveOutput("dsh/wip/x", "feature\n1\n")).toEqual({
      ref: "dsh/wip/x",
      branch: "feature",
      committed: true,
    });
    expect(parseSaveOutput("dsh/wip/x", "\n0\n")).toEqual({
      ref: "dsh/wip/x",
      committed: false,
    });
    expect(() => parseSaveOutput("dsh/wip/x", "garbage")).toThrow(
      /unexpected checkpoint output/,
    );
  });

  it("hands the restore script everything it reads", () => {
    const env = restoreEnvironment({
      ref: "dsh/wip/x",
      branch: "feature",
      committed: true,
    });
    expect(env).toEqual({
      DSH_CHECKPOINT_REF: "dsh/wip/x",
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

  function manager(backend: FakeBackend, store?: SessionStore) {
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
      {
        backends: { ci: backend },
        gateway: gatewayFor(backend),
        ...(store === undefined ? {} : { store }),
      },
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

    client.execReplies.push({ stdout: "feature\n1\n" });
    await sandboxes.hibernate("session-one");

    const ref = checkpointRef("session-one");
    expect(client.execs).toHaveLength(1);
    expect(client.execs[0]?.env).toEqual({ DSH_CHECKPOINT_REF: ref });
    expect(client.execs[0]?.cwd).toBe("/workspace/repository");
    expect(backend.hibernations).toBe(0);
    expect(backend.destroys).toBe(1);
    expect(backend.expiries).toBe(0);
    const record = store.get("session-one");
    expect(record?.state).toBe("hibernated");
    expect(record?.expiresAt).toBeDefined();
    expect(record?.checkpoint).toEqual({
      ref,
      branch: "feature",
      committed: true,
    });

    await sandboxes.ensureRunning(agent);
    expect(backend.wakes).toBe(0);
    expect(backend.provisions).toBe(2);
    expect(client.setupRequests[1]).toEqual({ revision: ref });
    expect(client.execs).toHaveLength(2);
    expect(client.execs[1]?.env).toEqual({
      DSH_CHECKPOINT_REF: ref,
      DSH_CHECKPOINT_BRANCH: "feature",
      DSH_CHECKPOINT_COMMITTED: "1",
    });
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

  it("does not set a backend deadline for a checkpointed record on boot", async () => {
    const backend = new FakeBackend();
    const store = new SessionStore(join(directory, "sessions.json"));
    const sandboxes = manager(backend, store);

    await sandboxes.ensureRunning(agent);
    backend.client.execReplies.push({ stdout: "\n0\n" });
    await sandboxes.hibernate("session-one");

    const restarted = manager(backend, store);
    await restarted.getSessionProfile("session-one");
    expect(backend.expiries).toBe(0);
    expect(store.get("session-one")?.state).toBe("hibernated");
  });
});
