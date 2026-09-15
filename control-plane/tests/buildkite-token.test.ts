import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultBuildkiteTokenCredential } from "../src/buildkite-credential.js";
import {
  resolveBuildkiteToken,
  type CredentialResolver,
} from "../src/buildkite-token.js";
import { resolveConfig } from "../src/config.js";
import type { BuildkiteProfile } from "../src/types.js";

function profileOf(name: string): BuildkiteProfile {
  const config = resolveConfig({
    profiles: {
      [name]: {
        backend: "buildkite",
        organization: "acme",
        pipeline: "dsh-yawn",
        controlPlaneUrl: "wss://dsh.example.com/tunnel",
      },
    },
  });
  const profile = config.profiles[name];
  if (profile?.backend !== "buildkite") {
    throw new Error("expected a Buildkite profile");
  }
  return profile;
}

/** A credential service double holding one value per reference. */
function credentialsWith(values: Record<string, string>): CredentialResolver {
  return {
    async resolve(ref) {
      const value = values[String(ref)];
      return value === undefined ? undefined : { value };
    },
  };
}

describe("resolveBuildkiteToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives one credential name per profile", () => {
    expect(defaultBuildkiteTokenCredential("hosted")).toBe(
      "DSH_YAWN_BUILDKITE_HOSTED_TOKEN",
    );
    expect(defaultBuildkiteTokenCredential("second-org")).toBe(
      "DSH_YAWN_BUILDKITE_SECOND_ORG_TOKEN",
    );
  });

  it("prefers the profile's stored credential over the environment", async () => {
    vi.stubEnv("BUILDKITE_API_TOKEN", "from-environment");
    await expect(
      resolveBuildkiteToken(
        profileOf("hosted"),
        credentialsWith({
          DSH_YAWN_BUILDKITE_HOSTED_TOKEN: "from-credential-document",
        }),
      ),
    ).resolves.toBe("from-credential-document");
  });

  it("falls back to BUILDKITE_API_TOKEN when the profile stores nothing", async () => {
    vi.stubEnv("BUILDKITE_API_TOKEN", "from-environment");
    await expect(
      resolveBuildkiteToken(profileOf("hosted"), credentialsWith({})),
    ).resolves.toBe("from-environment");
  });

  it("falls back to BUILDKITE_API_TOKEN when no service is mounted", async () => {
    vi.stubEnv("BUILDKITE_API_TOKEN", "from-environment");
    await expect(
      resolveBuildkiteToken(profileOf("hosted"), undefined),
    ).resolves.toBe("from-environment");
  });

  it("names the profile and the setting to fix when neither holds a token", async () => {
    vi.stubEnv("BUILDKITE_API_TOKEN", "");
    await expect(
      resolveBuildkiteToken(profileOf("hosted"), credentialsWith({})),
    ).rejects.toThrow(
      /profile hosted needs a Buildkite API token: enter one in Settings → Sandboxes, or set BUILDKITE_API_TOKEN on the control plane/,
    );
  });
});
