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
      idleMs: 30_000,
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

  it("arms the running expiry at provision, swaps it for retention at hibernate, and renews it at wake", async () => {
    await engine.initialize();
    const t0 = Date.now();
    await engine.ensureRunning("session-one", async () => REPOSITORY);
    // Provision arms the expiry: a full idle-plus-retention cycle.
    const provisionDeadline = backend.expiryDeadlines[0]?.getTime();
    expect(provisionDeadline).toBeGreaterThanOrEqual(t0 + 90_000);
    expect(provisionDeadline).toBeLessThanOrEqual(Date.now() + 90_000);
    expect(store.get("session-one")?.expiresAt).toBeDefined();

    // Suspension replaces the running expiry with the plain retention
    // deadline.
    await engine.hibernate("session-one");
    const hibernateDeadline = backend.expiryDeadlines.at(-1)?.getTime();
    expect(hibernateDeadline).toBeGreaterThanOrEqual(t0 + 60_000);
    expect(hibernateDeadline).toBeLessThanOrEqual(Date.now() + 60_000);

    // Waking renews it: the KAS wake clears the claim's expiry first.
    const t1 = Date.now();
    await engine.ensureRunning("session-one", async () => REPOSITORY);
    expect(backend.wakes).toBe(1);
    const wakeDeadline = backend.expiryDeadlines.at(-1)?.getTime();
    expect(wakeDeadline).toBeGreaterThanOrEqual(t1 + 90_000);
    expect(wakeDeadline).toBeLessThanOrEqual(Date.now() + 90_000);
    expect(store.get("session-one")?.state).toBe("running");
  });

  it("re-arms a running record's exact expiry at boot", async () => {
    await store.initialize();
    const deadline = new Date(Date.now() + 5 * 60_000);
    await store.set({
      sessionId: "live",
      backend: "fake",
      profile: "standard",
      sandboxId: "sandbox-one",
      reference: { id: "one" },
      repositoryUrl: REPOSITORY,
      state: "running",
      expiresAt: deadline.toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await engine.initialize();
    expect(backend.expiryDeadlines.at(-1)?.getTime()).toBe(deadline.getTime());
    expect(backend.destroys).toBe(0);
    expect(store.get("live")?.state).toBe("running");
  });

  it("releases a running sandbox whose expiry passed while the host was down", async () => {
    await store.initialize();
    await store.set({
      sessionId: "stale",
      backend: "fake",
      profile: "standard",
      sandboxId: "sandbox-one",
      reference: { id: "one" },
      repositoryUrl: REPOSITORY,
      state: "running",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await engine.initialize();
    expect(store.get("stale")).toBeUndefined();
    expect(backend.destroys).toBe(1);
  });

  it("arms a fresh expiry for a legacy running record without one", async () => {
    await store.initialize();
    await store.set({
      sessionId: "legacy",
      backend: "fake",
      profile: "standard",
      sandboxId: "sandbox-one",
      reference: { id: "one" },
      repositoryUrl: REPOSITORY,
      state: "running",
      updatedAt: new Date().toISOString(),
    });

    const t0 = Date.now();
    await engine.initialize();
    const deadline = backend.expiryDeadlines.at(-1)?.getTime();
    expect(deadline).toBeGreaterThanOrEqual(t0 + 90_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 90_000);
    expect(store.get("legacy")?.expiresAt).toBeDefined();
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
