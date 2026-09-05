import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialBroker } from "../src/broker.js";
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

describe("sandbox lifecycle engine", () => {
  let directory: string;
  let store: SessionStore;
  let backend: FakeBackend;
  let engine: SandboxLifecycle;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-lifecycle-"));
    store = new SessionStore(join(directory, "sessions.json"));
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    backend = new FakeBackend();
    const registry = new ProfileRegistry(
      { standard: PROFILE },
      { standard: backend },
      undefined,
    );
    const attachment = new RunnerAttachment({
      gateway: gatewayFor(backend),
      broker,
      revision: "",
      workspace: "/workspace/repository",
    });
    engine = new SandboxLifecycle({
      store,
      registry,
      pendingProfile: () => PROFILE,
      attachment,
      expiresAfterMs: 60_000,
      warn: () => {},
    });
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
});
