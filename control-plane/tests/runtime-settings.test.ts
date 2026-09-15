import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import FileSettingsProvider from "@deepseek-ai/dsh-settings-file";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import { ProfileRegistry } from "../src/manager/profile-registry.js";
import { RuntimeSettings } from "../src/manager/runtime-settings.js";
import { FakeBackend, gatewayFor, sleep } from "./fakes.js";

/**
 * The runtime settings slice over the real settings service: the file-backed
 * provider, the `sandbox-manager` namespace the manager installs, and the
 * live re-resolve a committed change triggers.
 */
describe("sandbox-manager settings", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-yawn-settings-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function managerOver(settingsFile: string): Promise<{
    manager: SandboxManager;
    settings: SettingsProvider;
    standard: FakeBackend;
  }> {
    const ctx = new Context();
    ctx.plugin(FileSettingsProvider, { path: settingsFile });
    const standard = new FakeBackend();
    // An empty credential store: Buildkite tokens resolve per request, so a
    // profile can be added and applied before its token is entered.
    const credentials = { resolve: async () => undefined };
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      { backends: { standard }, gateway: gatewayFor(standard), credentials },
    );
    const settings = await new Promise<SettingsProvider>((resolve) => {
      ctx.inject(["settings"], (settingsCtx) => {
        resolve(settingsCtx.settings);
      });
    });
    return { manager, settings, standard };
  }

  /** Poll until the probe passes, so watcher-settled changes are stable. */
  async function until(
    probe: () => Promise<boolean>,
    what: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await probe()) {
        return;
      }
      await sleep(20);
    }
    expect(await probe(), what).toBe(true);
  }

  const names = async (manager: SandboxManager, sessionId: string) =>
    (await manager.getSessionProfile(sessionId)).profiles
      .map((profile) => profile.name)
      .sort();

  it("applies a profile added through the settings service without a restart", async () => {
    const { manager, settings } = await managerOver(
      join(directory, "settings.yaml"),
    );
    expect(await names(manager, "session-one")).toEqual(["standard"]);

    await settings.update("sandbox-manager", {
      profiles: {
        standard: { backend: "docker" },
        large: { backend: "docker", image: "dsh-runner:dev" },
      },
    });

    await until(
      async () => (await names(manager, "session-one")).includes("large"),
      "the new profile appears in the composer chip's options",
    );
    const view = await manager.getSessionProfile("session-one");
    expect(view.selected).toBe("standard");
  });

  it("resets to the row's configuration when the user layer empties", async () => {
    const { manager, settings } = await managerOver(
      join(directory, "settings.yaml"),
    );
    await settings.replace("sandbox-manager", {
      profiles: { large: { backend: "docker", image: "dsh-runner:dev" } },
    });
    await until(
      async () => (await names(manager, "session-one")).includes("large"),
      "the override applies",
    );

    await settings.replace("sandbox-manager", {});
    await until(
      async () => (await names(manager, "session-one")).join() === "standard",
      "the row's profiles return",
    );
  });

  it("applies a Buildkite profile before its token is set", async () => {
    const { manager, settings } = await managerOver(
      join(directory, "settings.yaml"),
    );
    await settings.update("sandbox-manager", {
      profiles: {
        standard: { backend: "docker" },
        hosted: {
          backend: "buildkite",
          organization: "acme",
          pipeline: "dsh-yawn",
          controlPlaneUrl: "wss://dsh.example.com/tunnel",
        },
      },
    });
    // The token resolves per request, so adding the profile is not refused;
    // its sessions fail with the setting to fix until a token exists.
    await until(
      async () => (await names(manager, "session-one")).includes("hosted"),
      "the Buildkite profile applies without a token",
    );
  });

  it("refuses a write the host cannot apply", async () => {
    const { settings } = await managerOver(join(directory, "settings.yaml"));
    await expect(
      settings.update("sandbox-manager", { defaultProfile: "missing" }),
    ).rejects.toThrow(/not a configured profile/);
  });

  it("keeps the row's profiles when the document starts invalid", async () => {
    const settingsFile = join(directory, "settings.yaml");
    await writeFile(
      settingsFile,
      "sandbox-manager:\n  defaultProfile: ghost\n",
      "utf8",
    );
    const { manager } = await managerOver(settingsFile);
    expect(await names(manager, "session-one")).toEqual(["standard"]);
  });

  it("hot-reloads a direct edit of the settings document", async () => {
    const settingsFile = join(directory, "settings.yaml");
    const { manager } = await managerOver(settingsFile);
    await manager.getSessionProfile("session-one");
    await writeFile(
      settingsFile,
      [
        "sandbox-manager:",
        "  profiles:",
        "    standard:",
        "      backend: docker",
        "    large:",
        "      backend: docker",
        "      image: dsh-runner:dev",
        "",
      ].join("\n"),
      "utf8",
    );
    await until(
      async () => (await names(manager, "session-one")).includes("large"),
      "the externally edited profile appears",
    );
  });
});

describe("ProfileRegistry.update", () => {
  it("keeps a backend whose profile is unchanged and rebuilds the rest", () => {
    const kept = new FakeBackend();
    const standard = {
      name: "standard",
      backend: "docker" as const,
      image: "default-image",
      controlPlaneUrl: "ws://host.docker.internal:8081/tunnel",
    };
    const registry = new ProfileRegistry(
      { standard },
      { standard: kept },
      "token",
    );

    registry.update({
      standard,
      large: { ...standard, name: "large", image: "dsh-runner:dev" },
    });
    expect(registry.backendOf("standard")).toBe(kept);
    const built = registry.backendOf("large");
    expect(built).toBeDefined();

    // An edited profile gets a rebuilt backend — the replacement for
    // `standard` stays authoritative for its name, so prove the rebuild on
    // `large`, which this registry builds itself.
    registry.update({
      standard,
      large: { ...standard, name: "large", image: "dsh-runner:next" },
    });
    expect(registry.backendOf("standard")).toBe(kept);
    expect(registry.backendOf("large")).not.toBe(built);

    registry.update({ standard });
    expect(registry.backendOf("large")).toBeUndefined();
  });
});

describe("RuntimeSettings", () => {
  it("reports timer changes without claiming a profile change", () => {
    const initial = {
      profiles: {},
      defaultProfile: undefined,
      idleMs: 60_000,
      expiresAfterMs: 604_800_000,
    };
    const holder = new RuntimeSettings(initial);
    expect(holder.apply({ ...initial, idleMs: 120_000 })).toBe(false);
    expect(holder.idleMs).toBe(120_000);
    expect(holder.expiresAfterMs).toBe(604_800_000);
    expect(
      holder.apply({
        ...initial,
        profiles: {
          standard: {
            name: "standard",
            backend: "docker",
            image: "default-image",
            controlPlaneUrl: "ws://host.docker.internal:8081/tunnel",
          },
        },
      }),
    ).toBe(true);
  });
});
