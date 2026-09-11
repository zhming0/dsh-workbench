import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialBroker } from "../src/broker.js";
import { CheckpointStore, restoreEnvironment } from "../src/checkpoint.js";
import { SandboxLifecycle } from "../src/manager/sandbox-lifecycle.js";
import { ProfileRegistry } from "../src/manager/profile-registry.js";
import { RunnerAttachment } from "../src/manager/runner-attachment.js";
import { SessionStore } from "../src/state-store.js";
import type { SandboxProfile } from "../src/types.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

const PROFILE: SandboxProfile = {
  name: "standard",
  backend: "docker",
  image: "runner:test",
  hostUrl: "tcp://host.docker.internal:8081",
};

const REPOSITORY = "https://github.com/example/repo.git";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("sandbox lifecycle engine", () => {
  let directory: string;
  let store: SessionStore;
  let backend: FakeBackend;
  let engine: SandboxLifecycle;

  /** A new engine over the same store and backend: what a host restart sees. */
  async function engineFor(
    store: SessionStore,
    backend: FakeBackend,
  ): Promise<SandboxLifecycle> {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    const registry = new ProfileRegistry(
      { standard: PROFILE },
      { standard: backend },
      undefined,
    );
    const attachment = new RunnerAttachment({
      gateway: gatewayFor(backend),
      broker,
      revision: "v1",
      workspace: "/workspace/repository",
    });
    return new SandboxLifecycle({
      store,
      registry,
      pendingProfile: () => PROFILE,
      attachment,
      checkpoints: new CheckpointStore(join(directory, "checkpoints")),
      expiresAfterMs: 60_000,
      warn: () => {},
    });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-lifecycle-"));
    store = new SessionStore(join(directory, "sessions.json"));
    backend = new FakeBackend();
    engine = await engineFor(store, backend);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("provisions, serves from the cache, then wakes after hibernation", async () => {
    await engine.initialize();
    const restores: string[] = [];
    const wakes: Array<{ sessionId: string; keepsFilesystem: boolean }> = [];
    engine.addHooks({
      afterRestore: async ({ sessionId }) => {
        restores.push(sessionId);
      },
      afterWake: async ({ sessionId, keepsFilesystem }) => {
        wakes.push({ sessionId, keepsFilesystem });
      },
    });
    const first = await engine.ensureRunning(
      "session-one",
      async () => REPOSITORY,
    );
    expect(first).toBe(backend.client);
    expect(restores).toEqual([]);
    expect(wakes).toEqual([]);
    expect(backend.provisions).toBe(1);
    expect(store.get("session-one")?.state).toBe("running");

    await engine.ensureRunning("session-one", async () => REPOSITORY);
    expect(backend.provisions).toBe(1);
    expect(backend.client.setups).toBe(1);

    expect(await engine.hibernate("session-one")).toBe(true);
    expect(backend.hibernations).toBe(1);
    expect(store.get("session-one")?.state).toBe("hibernated");

    // A wake is not a checkpoint restore: the bundle seam stays quiet while
    // the wake seam names the machine the backend handed back.
    const woken = await engine.ensureRunning(
      "session-one",
      async () => REPOSITORY,
    );
    expect(woken).toBe(backend.client);
    expect(restores).toEqual([]);
    expect(wakes).toEqual([
      { sessionId: "session-one", keepsFilesystem: true },
    ]);
    expect(backend.wakes).toBe(1);
    expect(backend.provisions).toBe(1);
  });

  it("reports a wake that rebuilt the machine instead of reusing it", async () => {
    backend.capabilities.wakeKeepsFilesystem = false;
    const wakes: Array<{ sessionId: string; keepsFilesystem: boolean }> = [];
    engine.addHooks({
      afterWake: async ({ sessionId, keepsFilesystem }) => {
        wakes.push({ sessionId, keepsFilesystem });
      },
    });
    await engine.initialize();
    await engine.ensureRunning("session-one", async () => REPOSITORY);
    await engine.hibernate("session-one");
    await engine.ensureRunning("session-one", async () => REPOSITORY);
    expect(wakes).toEqual([
      { sessionId: "session-one", keepsFilesystem: false },
    ]);
  });

  it("says nothing when a wake only probes a backend that cannot hibernate", async () => {
    backend.capabilities.supportsHibernate = false;
    const announced: unknown[] = [];
    engine.addHooks({
      afterWake: async (context) => {
        announced.push(context);
      },
    });
    await engine.initialize();
    await engine.ensureRunning("session-one", async () => REPOSITORY);
    // The record says running and the runner is gone; the backend hands back
    // the same machine, which was never put away.
    backend.running = false;
    backend.client.healthy = false;
    await engine.ensureRunning("session-one", async () => REPOSITORY);
    expect(backend.wakes).toBe(1);
    expect(announced).toEqual([]);
  });

  it("recovers a dead runner by waking its sandbox", async () => {
    await engine.initialize();
    await engine.ensureRunning("session-one", async () => REPOSITORY);
    backend.running = false;
    backend.client.healthy = false;
    await engine.ensureRunning("session-one", async () => REPOSITORY);
    expect(backend.wakes).toBe(1);
    expect(backend.provisions).toBe(1);
  });

  it("releases a sandbox whose retention expired while the host was down", async () => {
    const released: string[] = [];
    engine.addHooks({
      afterRelease: async (sessionId) => {
        released.push(sessionId);
      },
    });
    await store.initialize();
    await store.set({
      sessionId: "stale",
      backend: "fake",
      profile: "standard",
      sandboxId: "sandbox-one",
      reference: { id: "one" },
      repositoryUrl: REPOSITORY,
      state: "hibernated",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await engine.initialize();
    expect(store.get("stale")).toBeUndefined();
    expect(released).toEqual(["stale"]);
  });

  it("runs lifecycle hooks in registration order at the engine's seams", async () => {
    const order: string[] = [];
    engine.addHooks({
      beforeHibernate: async ({ sessionId }) => {
        order.push(`first:${sessionId}`);
      },
      afterRelease: async (sessionId) => {
        order.push(`first-release:${sessionId}`);
      },
    });
    engine.addHooks({
      beforeHibernate: async ({ sessionId }) => {
        order.push(`second:${sessionId}`);
      },
      beforeCheckpoint: async ({ sessionId }) => {
        order.push(`checkpoint:${sessionId}`);
      },
    });
    await engine.initialize();
    await engine.ensureRunning("session-one", async () => REPOSITORY);

    // A hibernating backend fires beforeHibernate only.
    expect(await engine.hibernate("session-one")).toBe(true);
    expect(order).toEqual(["first:session-one", "second:session-one"]);

    await engine.release("session-one");
    expect(order).toEqual([
      "first:session-one",
      "second:session-one",
      "first-release:session-one",
    ]);
  });

  it("leaves the session untouched when a guard refuses", async () => {
    await engine.initialize();
    await engine.ensureRunning("session-one", async () => REPOSITORY);

    expect(await engine.hibernate("session-one", () => false)).toBe(false);
    expect(store.get("session-one")?.state).toBe("running");
    await engine.release("session-one", () => false);
    expect(store.get("session-one")?.state).toBe("running");
  });

  describe("on a backend that cannot hibernate", () => {
    const BUNDLE = new TextEncoder().encode("# v2 git bundle\nobjects");
    const SAVE_OUTPUT = new Uint8Array([
      ...new TextEncoder().encode(`feature\n${COMMIT}\n`),
      ...BUNDLE,
    ]);
    const bundlePath = () =>
      join(directory, "checkpoints", "session-one.bundle");

    beforeEach(() => {
      backend.capabilities.supportsHibernate = false;
    });

    it("saves the tree on idle and restores it into a new sandbox", async () => {
      const client = backend.client;
      const restores: string[] = [];
      engine.addHooks({
        afterRestore: async ({ sessionId }) => {
          restores.push(sessionId);
        },
      });
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      expect(client.setupRequests).toEqual([{ revision: "v1" }]);

      client.execReplies.push({ stdout: SAVE_OUTPUT });
      expect(await engine.hibernate("session-one")).toBe(true);

      const checkpoint = { commit: COMMIT, branch: "feature" };
      expect(client.execs).toHaveLength(1);
      expect(client.execs[0]?.cwd).toBe("/workspace/repository");
      expect(backend.hibernations).toBe(0);
      expect(backend.destroys).toBe(1);
      expect(backend.expiries).toBe(0);
      const saved = store.get("session-one");
      if (saved?.state !== "checkpointed") {
        throw new Error("expected a checkpointed record");
      }
      expect(saved.checkpoint).toEqual(checkpoint);
      expect(saved.expiresAt).toBeDefined();
      expect(saved).not.toHaveProperty("sandboxId");
      expect(new Uint8Array(await readFile(bundlePath()))).toEqual(BUNDLE);

      // The restore turn is the one that fires the seam, once.
      const restored = await engine.ensureRunning(
        "session-one",
        async () => REPOSITORY,
      );
      expect(restored).toBe(backend.client);
      expect(restores).toEqual(["session-one"]);
      expect(backend.wakes).toBe(0);
      expect(backend.provisions).toBe(2);
      // The clone is the usual one; the restore brings the work in afterwards.
      expect(client.setupRequests[1]).toEqual({ revision: "v1" });
      expect(client.execs).toHaveLength(2);
      expect(client.execs[1]?.env).toEqual(
        restoreEnvironment(checkpoint, BUNDLE),
      );
      expect(new Uint8Array(client.execs[1]?.stdin ?? [])).toEqual(BUNDLE);
      const resumed = store.get("session-one");
      expect(resumed?.state).toBe("running");
      expect(resumed).not.toHaveProperty("checkpoint");
      expect(resumed).not.toHaveProperty("expiresAt");
      expect(existsSync(bundlePath())).toBe(false);

      // The next turn serves the restored sandbox and fires nothing.
      const again = await engine.ensureRunning(
        "session-one",
        async () => REPOSITORY,
      );
      expect(again).toBe(backend.client);
      expect(restores).toEqual(["session-one"]);
      expect(backend.provisions).toBe(2);
    });

    it("keeps the sandbox when the save fails", async () => {
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      backend.client.execReplies.push({ exitCode: 1 });
      await expect(engine.hibernate("session-one")).rejects.toThrow(
        /checkpoint script failed with exit code 1/,
      );
      expect(backend.destroys).toBe(0);
      expect(backend.running).toBe(true);
      expect(store.get("session-one")?.state).toBe("running");
      expect(existsSync(bundlePath())).toBe(false);
    });

    it("records the checkpoint before the destroy, so a lost destroy cannot lose the work", async () => {
      const client = backend.client;
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      client.execReplies.push({ stdout: SAVE_OUTPUT });
      // The same durable state a host crash between the two steps leaves.
      backend.destroyFailure = new Error("backend unreachable");
      await expect(engine.hibernate("session-one")).rejects.toThrow(
        /backend unreachable/,
      );
      expect(backend.destroys).toBe(1);
      expect(store.get("session-one")?.state).toBe("checkpointed");
      expect(existsSync(bundlePath())).toBe(true);

      // The next turn restores from the bundle instead of cloning fresh.
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      expect(backend.provisions).toBe(2);
      expect(client.execs).toHaveLength(2);
      expect(client.execs[1]?.env.DSH_CHECKPOINT_COMMIT).toBe(COMMIT);
      expect(store.get("session-one")?.state).toBe("running");
    });

    it("writes the running record only once the restore has succeeded", async () => {
      const client = backend.client;
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      client.execReplies.push({ stdout: SAVE_OUTPUT });
      await engine.hibernate("session-one");

      // How many runner commands had run when each record was written: the
      // running record must come after the restore (the second exec), so a
      // crash mid-restore still finds a checkpointed record and the bundle.
      const writes: Array<{ state: string; execs: number }> = [];
      const set = store.set.bind(store);
      store.set = async (record) => {
        writes.push({ state: record.state, execs: client.execs.length });
        await set(record);
      };
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      expect(writes).toEqual([{ state: "running", execs: 2 }]);
      expect(existsSync(bundlePath())).toBe(false);
    });

    it("gives the sandbox up when the restore fails and retries on the next turn", async () => {
      const client = backend.client;
      const restores: string[] = [];
      engine.addHooks({
        afterRestore: async ({ sessionId }) => {
          restores.push(sessionId);
        },
      });
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      client.execReplies.push({ stdout: SAVE_OUTPUT });
      await engine.hibernate("session-one");
      const saved = store.get("session-one");
      if (saved?.state !== "checkpointed") {
        throw new Error("expected a checkpointed record");
      }

      // The restore script fails in the replacement sandbox; nothing is
      // announced, because there is nothing to tell the model yet.
      client.execReplies.push({ exitCode: 1 });
      await expect(
        engine.ensureRunning("session-one", async () => REPOSITORY),
      ).rejects.toThrow(/checkpoint script failed/);
      expect(restores).toEqual([]);
      expect(backend.provisions).toBe(2);
      expect(backend.destroys).toBe(2);
      expect(store.get("session-one")).toMatchObject({
        state: "checkpointed",
        checkpoint: saved.checkpoint,
      });
      expect(existsSync(bundlePath())).toBe(true);

      // The next turn provisions again and restores from the same bundle.
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      expect(restores).toEqual(["session-one"]);
      expect(backend.provisions).toBe(3);
      expect(client.execs).toHaveLength(3);
      expect(client.execs[2]?.env.DSH_CHECKPOINT_COMMIT).toBe(COMMIT);
      expect(new Uint8Array(client.execs[2]?.stdin ?? [])).toEqual(BUNDLE);
      expect(store.get("session-one")?.state).toBe("running");
    });

    it("fails the turn without provisioning when the bundle is gone", async () => {
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      backend.client.execReplies.push({ stdout: SAVE_OUTPUT });
      await engine.hibernate("session-one");
      await rm(bundlePath());

      await expect(
        engine.ensureRunning("session-one", async () => REPOSITORY),
      ).rejects.toThrow(/checkpoint of session session-one is missing/);
      expect(backend.provisions).toBe(1);
      expect(store.get("session-one")?.state).toBe("checkpointed");
    });

    it("reconnects to the runner after a host restart so hooks and the save both see it", async () => {
      const seen: string[] = [];
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);

      const restarted = await engineFor(store, backend);
      restarted.addHooks({
        beforeHibernate: async () => {
          seen.push("hibernate");
        },
        beforeCheckpoint: async ({ client }) => {
          seen.push(
            `checkpoint:${String((client as unknown) === backend.client)}`,
          );
        },
      });
      backend.client.execReplies.push({ stdout: `\n${COMMIT}\n` });
      await restarted.hibernate("session-one");
      // Only the checkpoint hook fires, with the reconnected runner.
      expect(seen).toEqual(["checkpoint:true"]);
      expect(backend.client.execs).toHaveLength(1);
      expect(store.get("session-one")).toMatchObject({
        state: "checkpointed",
        checkpoint: { commit: COMMIT },
      });
      // A commit the remote already has needs no bundle; the file still marks
      // the checkpoint as complete.
      expect((await readFile(bundlePath())).byteLength).toBe(0);
    });

    it("drops the record when the sandbox vanished before the save", async () => {
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      // A host restart forgets the runner client; the build has since ended.
      backend.running = false;
      const restarted = await engineFor(store, backend);
      await restarted.hibernate("session-one");
      expect(backend.client.execs).toHaveLength(0);
      expect(store.get("session-one")).toBeUndefined();
    });

    it("never touches the backend again for a checkpointed record", async () => {
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      backend.client.execReplies.push({ stdout: `\n${COMMIT}\n` });
      await engine.hibernate("session-one");
      expect(backend.destroys).toBe(1);

      // Boot: no deadline to set on a sandbox that no longer exists.
      const restarted = await engineFor(store, backend);
      await restarted.initialize();
      expect(backend.expiries).toBe(0);
      expect(store.get("session-one")?.state).toBe("checkpointed");

      // Expiry: the record and its bundle go, without a second destroy.
      const record = store.get("session-one");
      if (record?.state !== "checkpointed") {
        throw new Error("expected a checkpointed record");
      }
      await store.set({ ...record, expiresAt: new Date(0).toISOString() });
      const expired = await engineFor(store, backend);
      await expired.initialize();
      expect(store.get("session-one")).toBeUndefined();
      expect(backend.destroys).toBe(1);
      expect(existsSync(bundlePath())).toBe(false);
    });
  });
});
