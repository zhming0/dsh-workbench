import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";
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
        remote: { backend: "docker", hostUrl: "tcp://10.0.0.1:8081" },
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
        hostUrl: "tcp://host.docker.internal:9000",
      },
      remote: {
        name: "remote",
        backend: "docker",
        image: DEFAULT_RUNNER_IMAGE,
        hostUrl: "tcp://10.0.0.1:8081",
      },
    });

    expect(() =>
      resolveConfig({
        defaultProfile: "missing",
        profiles: { standard: { backend: "docker" } },
      }),
    ).toThrow("defaultProfile missing is not a configured profile");
    expect(() => resolveConfig({ profiles: {} })).toThrow(
      "at least one profile",
    );
  });
});
