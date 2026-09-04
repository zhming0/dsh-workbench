import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { agentEvents, type Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialBroker } from "../src/broker.js";
import { SandboxManager } from "../src/manager.js";
import { SessionStore } from "../src/state-store.js";
import {
  FakeBackend,
  FakeWorkspaceRegistry,
  gatewayFor,
  sleep,
} from "./fakes.js";

describe("sandbox lifecycle", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("provisions, hibernates, and wakes one sandbox per session", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    expect(manager.workspace).toBe("/workspace/repository");
    await manager.ensureRunning(agent);
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);
    expect(backend.client.setups).toBe(1);
    expect(backend.expiries).toBe(0);

    const cliBroker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await cliBroker.initialize();
    await cliBroker.setSecret("UPDATED_IN_CLI", "available-on-next-command");
    await manager.ensureRunning(agent);
    expect(backend.client.secrets).toEqual({
      UPDATED_IN_CLI: "available-on-next-command",
    });

    backend.running = false;
    backend.client.healthy = false;
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);
    expect(backend.wakes).toBe(1);

    await manager.hibernate("session-one");
    expect(backend.expiries).toBe(1);
    await manager.ensureRunning(agent);
    expect(backend.hibernations).toBe(1);
    expect(backend.wakes).toBe(2);
    expect(backend.client.setups).toBe(3);
  });

  it("suspends a session woken without a turn once its idle timer fires", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    // Provision, then wake again the way a Web UI session list does: the
    // cached client answers, no turn runs, and only a re-armed timer can
    // ever suspend the sandbox.
    await manager.ensureRunning(agent);
    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);

    await sleep(100);
    expect(backend.hibernations).toBe(1);
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    expect(store.get("session-one")?.state).toBe("hibernated");
    // The expiry countdown only starts when hibernation happens.
    expect(store.get("session-one")?.expiresAt).toBeDefined();

    // Waking the hibernated session re-arms instead of running forever.
    await manager.ensureRunning(agent);
    expect(backend.wakes).toBe(1);
    await sleep(100);
    expect(backend.hibernations).toBe(2);
  });

  it("does not suspend under a live turn and suspends after turn/end", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;
    const session = { id: "session-one" } as unknown as Session;

    await manager.ensureRunning(agent);
    ctx.emit("session/event", session, {
      type: "turn/start",
      data: { turn: 1 },
    } as unknown as SessionEvent);
    await sleep(100);
    expect(backend.hibernations).toBe(0);

    ctx.emit("session/event", session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    } as unknown as SessionEvent);
    await sleep(100);
    expect(backend.hibernations).toBe(1);
  });

  it("leaves provisioning and waking to the first prompt, not session-start", async () => {
    const backend = new FakeBackend();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 10,
        expiresAfterMs: 60_000,
      },
      { backends: { standard: backend }, gateway: gatewayFor(backend) },
    );
    const agent = {
      id: "session-one",
      session: { header: {} },
    } as unknown as Agent;

    // A blank session exists before the user has picked a profile, and every
    // UI action that resolves a cold session resumes it. Neither may schedule
    // a sandbox; the first pre-step does, through ensureRunning.
    ctx.emit("agent/session-start", { agent, source: "startup" });
    ctx.emit("agent/session-start", { agent, source: "resume" });
    await sleep(50);
    expect(backend.provisions).toBe(0);
    expect(backend.wakes).toBe(0);

    await manager.ensureRunning(agent);
    expect(backend.provisions).toBe(1);

    // A resume of a hibernated session leaves it hibernated.
    await manager.hibernate("session-one");
    ctx.emit("agent/session-start", { agent, source: "resume" });
    await sleep(50);
    expect(backend.wakes).toBe(0);
    const store = new SessionStore(join(directory, "sessions.json"));
    await store.initialize();
    expect(store.get("session-one")?.state).toBe("hibernated");
  });
});

describe("repository workspaces and instructions", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("registers a repository anchor before a Web session is created", async () => {
    const backend = new FakeBackend();
    const workspaceRegistry = new FakeWorkspaceRegistry();
    const ctx = new Context();
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/fallback.git",
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        workspaceRegistry,
      },
    );
    const anchor = await manager.createRepositoryWorkspace(
      "https://github.com/example/public.git",
    );
    await manager.setGlobalInstructions("Use concise answers.");
    await manager.setWorkspaceInstructions(
      "https://github.com/example/public.git",
      "Run the repository tests.",
    );
    const agent = {
      id: "session-one",
      session: {
        header: { cwd: anchor },
        events: [],
        surface: { nodes: [] },
      },
    } as unknown as Agent;

    await manager.ensureRunning(agent);

    const emptyDecision = await agentEvents(ctx, agent).waterfall(
      "agent/pre-step",
      {
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: "enter", messages: [] }),
    );
    const prompt = createUserMessage({
      content: [{ type: "text", text: "What instructions apply?" }],
      source: { kind: "user" },
    });
    const decision = await agentEvents(ctx, agent).waterfall(
      "agent/pre-step",
      {
        messages: [prompt],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: "enter", messages: [prompt] }),
    );

    expect(workspaceRegistry.creates).toEqual([
      { path: anchor, title: "example/public" },
    ]);
    expect(backend.repositoryUrls).toEqual([
      "https://github.com/example/public",
    ]);
    expect(emptyDecision).toEqual({ kind: "enter", messages: [] });
    expect(await manager.getInstructions()).toEqual({
      global: "Use concise answers.",
      workspaces: [
        {
          repositoryUrl: "https://github.com/example/public",
          title: "example/public",
          content: "Run the repository tests.",
        },
      ],
    });
    expect(decision).toMatchObject({
      kind: "enter",
      messages: [
        prompt,
        {
          content: [
            {
              type: "text",
              // vitest types stringMatching as `any`.
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              text: expect.stringMatching(
                /Use concise answers[\s\S]*Run the repository tests/,
              ),
            },
          ],
          source: {
            kind: "plugin",
            plugin: "@zhming0/dsh-workbench:instructions",
            form: "instructions",
          },
        },
      ],
    });
    await expect(
      manager.setWorkspaceInstructions(
        "https://github.com/example/unknown",
        "Do not save this.",
      ),
    ).rejects.toThrow("not registered");
    expect(
      (
        ctx.get("directoryPicker") as { capability(): { kind: string } }
      ).capability().kind,
    ).toBe("repository");
  });

  it("does not create repository anchors without the Web workspace service", async () => {
    const manager = new SandboxManager(
      new Context(),
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/fallback",
      },
      (() => {
        const backend = new FakeBackend();
        return {
          backends: { standard: backend },
          gateway: gatewayFor(backend),
        };
      })(),
    );
    await manager.ensureRunning({
      id: "headless-session",
      session: { header: {} },
    } as unknown as Agent);

    await expect(
      manager.createRepositoryWorkspace("https://github.com/example/public"),
    ).rejects.toThrow("Web profile");
    await expect(stat(join(directory, "workspace-anchors"))).rejects.toThrow();
  });
});
