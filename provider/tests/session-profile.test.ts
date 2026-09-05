import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import { SessionStore } from "../src/state-store.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

describe("session profile choice", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("provisions with the profile a session picked before its first prompt", async () => {
    const standard = new FakeBackend();
    const large = new FakeBackend();
    const config = {
      stateDir: directory,
      repository: "https://github.com/example/public.git",
      profiles: {
        standard: { backend: "docker" as const },
        large: { backend: "kas" as const, warmPool: "dsh-large" },
      },
    };
    const manager = new SandboxManager(new Context(), config, {
      backends: { standard, large },
      gateway: gatewayFor(large),
    });

    expect(await manager.getSessionProfile("session-one")).toEqual({
      profiles: [
        { name: "standard", backend: "docker" },
        { name: "large", backend: "kas" },
      ],
      selected: "standard",
      locked: false,
    });
    await expect(
      manager.setSessionProfile("session-one", "huge"),
    ).rejects.toThrow("unknown sandbox profile: huge");
    await manager.setSessionProfile("session-one", "large");

    // The choice survives a host restart before the sandbox exists.
    const restarted = new SandboxManager(new Context(), config, {
      backends: { standard, large },
      gateway: gatewayFor(large),
    });
    expect((await restarted.getSessionProfile("session-one")).selected).toBe(
      "large",
    );

    await restarted.ensureRunning({
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent);
    expect(standard.provisions).toBe(0);
    expect(large.provisions).toBe(1);
    const state = JSON.parse(
      await readFile(join(directory, "sessions.json"), "utf8"),
    ) as {
      sessions: Record<string, { backend: string; profile: string }>;
      pendingProfiles: Record<string, string>;
    };
    expect(state.sessions["session-one"]).toMatchObject({
      backend: "fake",
      profile: "large",
    });
    expect(state.pendingProfiles).toEqual({});

    expect(await restarted.getSessionProfile("session-one")).toMatchObject({
      selected: "large",
      locked: true,
    });
    await expect(
      restarted.setSessionProfile("session-one", "standard"),
    ).rejects.toThrow("already has a sandbox");
  });

  it("keeps sessions whose profile is no longer configured", async () => {
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    await store.set({
      sessionId: "session-one",
      backend: "kas",
      profile: "large",
      sandboxId: "sandbox-one",
      reference: { claimName: "claim-one", sandboxId: "sandbox-one" },
      repositoryUrl: "https://github.com/example/public.git",
      state: "hibernated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Same profile name, but the profile now points at a different backend.
    await store.set({
      sessionId: "session-two",
      backend: "kas",
      profile: "standard",
      sandboxId: "sandbox-two",
      reference: { claimName: "claim-two", sandboxId: "sandbox-two" },
      repositoryUrl: "https://github.com/example/public.git",
      state: "hibernated",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const backend = new FakeBackend();
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public",
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );

    for (const [sessionId, profile] of [
      ["session-one", "large"],
      ["session-two", "standard"],
    ]) {
      await expect(
        manager.ensureRunning({
          id: sessionId,
          session: { header: {} },
        } as unknown as Agent),
      ).rejects.toThrow(
        `kas sandbox from profile ${profile}, which is no longer configured on that backend`,
      );
    }
    expect(backend.provisions).toBe(0);
    const reopened = new SessionStore(join(directory, "sessions.json"));
    await reopened.initialize();
    expect(reopened.get("session-one")?.state).toBe("hibernated");
    expect(reopened.get("session-two")?.state).toBe("hibernated");
  });
});
