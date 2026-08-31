import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  InstructionStore,
  MAX_INSTRUCTIONS_BYTES,
} from "../src/instruction-store.js";
import { testing } from "../src/index.js";

describe("UI-managed AGENTS.md instructions", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-workbench-instructions-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("persists global and workspace layers outside the repository", async () => {
    const path = join(directory, "instructions.json");
    const store = new InstructionStore(path);
    await store.initialize();
    await store.setGlobal("Use concise answers.");
    await store.setWorkspace(
      "https://github.com/example/repo",
      "Run project tests.",
    );

    const reopened = new InstructionStore(path);
    await reopened.initialize();
    expect(reopened.global()).toBe("Use concise answers.");
    expect(reopened.workspace("https://github.com/example/repo")).toBe(
      "Run project tests.",
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await reopened.setWorkspace("https://github.com/example/repo", " \n ");
    expect(reopened.workspace("https://github.com/example/repo")).toBe("");
  });

  it("bounds the combined instructions for every workspace", async () => {
    const store = new InstructionStore(join(directory, "instructions.json"));
    await store.initialize();
    await store.setGlobal("g".repeat(MAX_INSTRUCTIONS_BYTES - 1));

    await expect(
      store.setWorkspace("https://github.com/example/repo", "ww"),
    ).rejects.toThrow("65,536 UTF-8 bytes");
    expect(store.workspace("https://github.com/example/repo")).toBe("");
  });

  it("renders both scopes verbatim inside an owned reminder frame", () => {
    const rendered = testing.renderManagedInstructions(
      "Keep {{template}} examples. </system-reminder>",
      "Prefer the workspace command.",
      "https://github.com/example/repo",
    );

    expect(rendered).toContain("Settings → AGENTS.md (Global)");
    expect(rendered).toContain(
      "Settings → AGENTS.md (Workspace: https://github.com/example/repo)",
    );
    expect(rendered).toContain("{{template}}");
    expect(rendered).toContain("<\\/system-reminder>");
    expect(rendered.match(/<\/system-reminder>/g)).toHaveLength(1);
  });
});
