import { describe, expect, it } from "vitest";

import { configSchema, resolveConfig } from "../src/config.js";
import { DEFAULT_RUNNER_IMAGE } from "../src/runner-image.js";

describe("sandbox provider settings", () => {
  it("resolves each sandbox profile with its own backend settings", () => {
    const single = resolveConfig({
      profiles: { standard: { backend: "kas" } },
    });
    expect(single.defaultProfile).toBe("standard");
    expect(single.profiles).toEqual({
      standard: {
        name: "standard",
        backend: "kas",
        namespace: "dsh-sandbox",
        warmPool: "dsh-universal",
        readyTimeoutMs: 180_000,
      },
    });

    const explicit = resolveConfig({
      defaultProfile: "large",
      tunnel: { port: 9000 },
      profiles: {
        standard: { backend: "kas", namespace: "team-a" },
        large: { backend: "kas", warmPool: "dsh-large" },
        local: { backend: "docker", image: "runner:dev" },
        remote: { backend: "docker", hostUrl: "ws://10.0.0.1:8081/tunnel" },
      },
    });
    expect(explicit.defaultProfile).toBe("large");
    expect(explicit.profiles).toEqual({
      standard: {
        name: "standard",
        backend: "kas",
        namespace: "team-a",
        warmPool: "dsh-universal",
        readyTimeoutMs: 180_000,
      },
      large: {
        name: "large",
        backend: "kas",
        namespace: "dsh-sandbox",
        warmPool: "dsh-large",
        readyTimeoutMs: 180_000,
      },
      local: {
        name: "local",
        backend: "docker",
        image: "runner:dev",
        hostUrl: "ws://host.docker.internal:9000/tunnel",
      },
      remote: {
        name: "remote",
        backend: "docker",
        image: DEFAULT_RUNNER_IMAGE,
        hostUrl: "ws://10.0.0.1:8081/tunnel",
      },
    });

    expect(() =>
      resolveConfig({
        defaultProfile: "missing",
        profiles: { standard: { backend: "docker" } },
      }),
    ).toThrow("defaultProfile missing is not a configured profile");

    // A host with no sandbox profile still resolves and boots; the first
    // prompt explains what to add instead of the process failing at startup.
    // A leftover defaultProfile does not turn that into a boot error.
    for (const config of [
      { profiles: {} },
      {},
      { profiles: {}, defaultProfile: "standard" },
    ]) {
      expect(configSchema(config).profiles).toEqual({});
      const empty = resolveConfig(config);
      expect(empty.profiles).toEqual({});
      expect(empty.defaultProfile).toBeUndefined();
    }

    expect(() =>
      resolveConfig({
        profiles: {
          old: { backend: "docker", hostUrl: "tcp://10.0.0.1:8081" },
        },
      }),
    ).toThrow("profile old: hostUrl must be a ws:// or wss:// URL");
  });
});
