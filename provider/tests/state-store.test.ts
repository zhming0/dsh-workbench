import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/state-store.js";

describe("session state store", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists session records atomically", async () => {
    const path = join(directory, "sessions.json");
    const store = new SessionStore(path);
    await store.initialize();
    await store.set({
      sessionId: "one",
      backend: "fake",
      profile: "standard",
      sandboxId: "sandbox-one",
      reference: { id: "one" },
      repositoryUrl: "https://github.com/example/repo.git",
      state: "running",
      updatedAt: new Date().toISOString(),
    });
    const reopened = new SessionStore(path);
    await reopened.initialize();
    expect(reopened.get("one")).toMatchObject({ sandboxId: "sandbox-one" });
  });
});
