import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialBroker } from "../src/broker.js";
import { checkpointRef, restoreEnvironment } from "../src/checkpoint.js";
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
    const first = await engine.ensureRunning(
      "session-one",
      async () => REPOSITORY,
    );
    expect(first).toBe(backend.client);
    expect(backend.provisions).toBe(1);
    expect(store.get("session-one")?.state).toBe("running");

    await engine.ensureRunning("session-one", async () => REPOSITORY);
    expect(backend.provisions).toBe(1);
    expect(backend.client.setups).toBe(1);

    expect(await engine.hibernate("session-one")).toBe(true);
    expect(backend.hibernations).toBe(1);
    expect(store.get("session-one")?.state).toBe("hibernated");

    await engine.ensureRunning("session-one", async () => REPOSITORY);
    expect(backend.wakes).toBe(1);
    expect(backend.provisions).toBe(1);
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
      beforeHibernate: async ({ sessionId, willSuspend }) => {
        order.push(`second:${sessionId}:${willSuspend}`);
      },
    });
    await engine.initialize();
    await engine.ensureRunning("session-one", async () => REPOSITORY);

    expect(await engine.hibernate("session-one")).toBe(true);
    expect(order).toEqual(["first:session-one", "second:session-one:true"]);

    await engine.release("session-one");
    expect(order).toEqual([
      "first:session-one",
      "second:session-one:true",
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
    beforeEach(() => {
      backend.capabilities.supportsHibernate = false;
    });

    it("pushes the tree on idle and restores it into a new sandbox", async () => {
      const client = backend.client;
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      expect(client.setupRequests).toEqual([{ revision: "v1" }]);

      client.execReplies.push({ stdout: `feature\n1\n${COMMIT}\n` });
      expect(await engine.hibernate("session-one")).toBe(true);

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
      const saved = store.get("session-one");
      if (saved?.state !== "checkpointed") {
        throw new Error("expected a checkpointed record");
      }
      expect(saved.checkpoint).toEqual(checkpoint);
      expect(saved.expiresAt).toBeDefined();
      expect(saved).not.toHaveProperty("sandboxId");

      await engine.ensureRunning("session-one", async () => REPOSITORY);
      expect(backend.wakes).toBe(0);
      expect(backend.provisions).toBe(2);
      expect(client.setupRequests[1]).toEqual({ revision: ref });
      expect(client.execs).toHaveLength(2);
      expect(client.execs[1]?.env).toEqual(restoreEnvironment(checkpoint));
      const resumed = store.get("session-one");
      expect(resumed?.state).toBe("running");
      expect(resumed).not.toHaveProperty("checkpoint");
      expect(resumed).not.toHaveProperty("expiresAt");
    });

    it("keeps the sandbox when the push fails", async () => {
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      backend.client.execReplies.push({ exitCode: 1 });
      await expect(engine.hibernate("session-one")).rejects.toThrow(
        /checkpoint script failed with exit code 1/,
      );
      expect(backend.destroys).toBe(0);
      expect(backend.running).toBe(true);
      expect(store.get("session-one")?.state).toBe("running");
    });

    it("gives the sandbox up when the restore fails and retries on the next turn", async () => {
      const client = backend.client;
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      client.execReplies.push({ stdout: `feature\n1\n${COMMIT}\n` });
      await engine.hibernate("session-one");
      const saved = store.get("session-one");
      if (saved?.state !== "checkpointed") {
        throw new Error("expected a checkpointed record");
      }

      // The restore script fails in the replacement sandbox.
      client.execReplies.push({ exitCode: 1 });
      await expect(
        engine.ensureRunning("session-one", async () => REPOSITORY),
      ).rejects.toThrow(/checkpoint script failed/);
      expect(backend.provisions).toBe(2);
      expect(backend.destroys).toBe(2);
      expect(store.get("session-one")).toMatchObject({
        state: "checkpointed",
        checkpoint: saved.checkpoint,
      });

      // The next turn provisions again and restores from the same checkpoint.
      await engine.ensureRunning("session-one", async () => REPOSITORY);
      expect(backend.provisions).toBe(3);
      expect(client.setupRequests[2]).toEqual({
        revision: saved.checkpoint.ref,
      });
      expect(client.execs).toHaveLength(3);
      expect(client.execs[2]?.env.DSH_CHECKPOINT_COMMIT).toBe(COMMIT);
      expect(store.get("session-one")?.state).toBe("running");
    });

    it("reconnects to the runner after a host restart so hooks and the push both see it", async () => {
      const seen: boolean[] = [];
      await engine.initialize();
      await engine.ensureRunning("session-one", async () => REPOSITORY);

      const restarted = await engineFor(store, backend);
      restarted.addHooks({
        beforeHibernate: async ({ client }) => {
          seen.push(client !== undefined);
        },
      });
      backend.client.execReplies.push({ stdout: `\n0\n${COMMIT}\n` });
      await restarted.hibernate("session-one");
      expect(seen).toEqual([true]);
      expect(backend.client.execs).toHaveLength(1);
      expect(store.get("session-one")?.state).toBe("checkpointed");
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
      backend.client.execReplies.push({ stdout: `\n0\n${COMMIT}\n` });
      await engine.hibernate("session-one");
      expect(backend.destroys).toBe(1);

      // Boot: no deadline to set on a sandbox that no longer exists.
      const restarted = await engineFor(store, backend);
      await restarted.initialize();
      expect(backend.expiries).toBe(0);
      expect(store.get("session-one")?.state).toBe("checkpointed");

      // Expiry: the record goes, without a second destroy.
      const record = store.get("session-one");
      if (record?.state !== "checkpointed") {
        throw new Error("expected a checkpointed record");
      }
      await store.set({ ...record, expiresAt: new Date(0).toISOString() });
      const expired = await engineFor(store, backend);
      await expired.initialize();
      expect(store.get("session-one")).toBeUndefined();
      expect(backend.destroys).toBe(1);
    });
  });
});
