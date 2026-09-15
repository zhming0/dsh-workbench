import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import { SandboxStatus } from "../src/manager/sandbox-status.js";
import { SessionStore } from "../src/state-store.js";
import type {
  CheckpointedRecord,
  HibernatedRecord,
  RunningRecord,
  SandboxProfile,
  SessionRecord,
} from "../src/types.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

const REPOSITORY = "https://github.com/example/public.git";

describe("sandbox status", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-control-plane-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("answers with the host record and the machine's own facts while running", async () => {
    const backend = new FakeBackend();
    const manager = newManager(directory, backend);
    await manager.ensureRunning(agent("session-one"));

    const status = await manager.getSandboxStatus("session-one");
    expect(status.sandbox).toMatchObject({
      backend: "fake",
      profile: "standard",
      image: "runner:test",
      sandboxId: "sandbox-one",
      state: "running",
      repositoryUrl: REPOSITORY,
    });
    expect(status.sandbox?.expiresAt).toBeUndefined();
    expect(status.sandbox?.startedAt).toBeDefined();
    expect(status.live).toEqual({
      hostname: "sandbox-one-host",
      osName: "Debian GNU/Linux 13 (trixie)",
      kernelVersion: "6.8.0",
      architecture: "amd64",
      cpuCount: 4,
      memoryTotalBytes: 2 * 2 ** 30,
      workspaceDiskUsedBytes: 1 * 2 ** 30,
      workspaceDiskTotalBytes: 8 * 2 ** 30,
      filesystemDiskUsedBytes: 3 * 2 ** 30,
      filesystemDiskTotalBytes: 16 * 2 ** 30,
      uptimeSeconds: 90,
    });
  });

  it("keeps the machine's start time across a wake", async () => {
    const backend = new FakeBackend();
    const manager = newManager(directory, backend);
    await manager.ensureRunning(agent("session-one"));
    const startedAt = (await manager.getSandboxStatus("session-one")).sandbox
      ?.startedAt;

    await manager.hibernate("session-one");
    expect(await manager.getSandboxStatus("session-one")).toMatchObject({
      sandbox: { state: "hibernated" },
    });

    await manager.ensureRunning(agent("session-one"));
    const woken = await manager.getSandboxStatus("session-one");
    expect(woken.sandbox).toMatchObject({ state: "running", startedAt });
    expect(backend.wakes).toBe(1);
  });

  it("describes a hibernated sandbox without waking it", async () => {
    const backend = new FakeBackend();
    const manager = newManager(directory, backend);
    await manager.ensureRunning(agent("session-one"));
    await manager.hibernate("session-one");

    const status = await manager.getSandboxStatus("session-one");
    expect(status.sandbox).toMatchObject({
      state: "hibernated",
      sandboxId: "sandbox-one",
    });
    expect(status.sandbox?.expiresAt).toBeDefined();
    expect(status.live).toBeUndefined();
    expect(backend.wakes).toBe(0);
    expect(backend.provisions).toBe(1);
  });

  it("describes a checkpointed session, whose sandbox no longer exists", async () => {
    const backend = new FakeBackend();
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    await store.set({
      sessionId: "session-one",
      backend: "fake",
      profile: "standard",
      repositoryUrl: REPOSITORY,
      state: "checkpointed",
      checkpoint: { commit: "abc123", branch: "main" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const manager = newManager(directory, backend);

    const status = await manager.getSandboxStatus("session-one");
    expect(status.sandbox).toMatchObject({
      state: "checkpointed",
      profile: "standard",
    });
    expect(status.sandbox?.sandboxId).toBeUndefined();
    expect(status.live).toBeUndefined();
    expect(backend.provisions).toBe(0);
  });

  it("reports nothing, and provisions nothing, for a session without a sandbox", async () => {
    const backend = new FakeBackend();
    const manager = newManager(directory, backend);

    expect(await manager.getSandboxStatus("session-one")).toEqual({});
    expect(backend.provisions).toBe(0);
  });

  it("answers for a record written before createdAt existed", async () => {
    // A sessions.json from a release that predates the createdAt field.
    const legacy = {
      version: 1,
      sessions: {
        "session-legacy": {
          sessionId: "session-legacy",
          backend: "docker",
          profile: "standard",
          sandboxId: "sandbox-legacy",
          reference: { id: "legacy" },
          repositoryUrl: REPOSITORY,
          state: "running",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
      pendingProfiles: {},
    };
    await writeFile(
      join(directory, "sessions.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );

    const manager = newManager(directory, new FakeBackend());
    const status = await manager.getSandboxStatus("session-legacy");
    // The oldest timestamp the host has is the honest start time for it.
    expect(status.sandbox?.startedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

function newManager(stateDir: string, backend: FakeBackend): SandboxManager {
  return new SandboxManager(
    new Context(),
    {
      stateDir,
      repository: REPOSITORY,
      profiles: { standard: { backend: "docker", image: "runner:test" } },
    },
    { backends: { standard: backend }, gateway: gatewayFor(backend) },
  );
}

function agent(sessionId: string): Agent {
  return { id: sessionId, session: { header: {} } } as unknown as Agent;
}

const DOCKER_PROFILE: SandboxProfile = {
  name: "standard",
  backend: "docker",
  image: "runner:test",
  controlPlaneUrl: "ws://host.docker.internal:8081/tunnel",
};

const KAS_PROFILE: SandboxProfile = {
  name: "standard",
  backend: "kas",
  namespace: "dsh-yawn",
  warmPool: "dsh-yawn-universal",
  readyTimeoutMs: 1_000,
};

const PROFILES: Record<string, SandboxProfile> = {
  standard: DOCKER_PROFILE,
};

const NOW = new Date().toISOString();

function runningRecord(sessionId = "session-one"): RunningRecord {
  return {
    sessionId,
    backend: "docker",
    profile: "standard",
    sandboxId: `sandbox-${sessionId}`,
    reference: { id: sessionId },
    repositoryUrl: REPOSITORY,
    state: "running",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function hibernatedRecord(sessionId = "session-one"): HibernatedRecord {
  return {
    ...runningRecord(sessionId),
    state: "hibernated",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function checkpointedRecord(sessionId = "checkpointed"): CheckpointedRecord {
  return {
    sessionId,
    backend: "docker",
    profile: "standard",
    repositoryUrl: REPOSITORY,
    state: "checkpointed",
    checkpoint: { commit: "abc123", branch: "main" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A store holding records and answering nothing for unknown sessions. */
function stubStore(records: SessionRecord[]): SessionStore {
  const byId = new Map(records.map((item) => [item.sessionId, item]));
  return {
    get: (sessionId: string) => byId.get(sessionId),
  } as unknown as SessionStore;
}

describe("SandboxStatus reads", () => {
  it("never asks for a runner unless the sandbox is running", async () => {
    const asked: string[] = [];
    const status = new SandboxStatus({
      store: stubStore([
        hibernatedRecord(),
        checkpointedRecord(),
        runningRecord("live"),
      ]),
      profiles: PROFILES,
      runnerFor: (sessionId) => {
        asked.push(sessionId);
        return undefined;
      },
    });

    const hibernated = await status.view("session-one");
    expect(hibernated.sandbox).toMatchObject({
      state: "hibernated",
      sandboxId: "sandbox-session-one",
      image: "runner:test",
    });
    expect(hibernated.sandbox?.expiresAt).toBeDefined();

    const checkpointed = await status.view("checkpointed");
    expect(checkpointed.sandbox).toMatchObject({ state: "checkpointed" });
    expect(checkpointed.sandbox?.sandboxId).toBeUndefined();
    expect(checkpointed.sandbox?.expiresAt).toBeDefined();

    // A session that was never provisioned reports nothing at all.
    expect(await status.view("never-provisioned")).toEqual({});

    // The point of the seam: describing a parked sandbox cannot reach the
    // lifecycle, so the only runner lookup is the running one.
    expect(asked).toEqual([]);

    await status.view("live");
    expect(asked).toEqual(["live"]);
  });

  it("leaves the image out for a backend that does not name one", async () => {
    const status = new SandboxStatus({
      store: stubStore([hibernatedRecord()]),
      profiles: { standard: KAS_PROFILE },
      runnerFor: () => undefined,
    });

    const view = await status.view("session-one");
    expect(view.sandbox?.image).toBeUndefined();
  });
});
