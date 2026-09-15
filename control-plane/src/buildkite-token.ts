import {
  credentialRef,
  type CredentialRef,
} from "@deepseek-ai/dsh-credentials";

import { defaultBuildkiteTokenCredential } from "./buildkite-credential.js";
import type { BuildkiteProfile } from "./types.js";

/** Environment variable a deployment can set instead of storing a token. */
export const DEFAULT_BUILDKITE_TOKEN_ENV = "BUILDKITE_API_TOKEN";

/**
 * The slice of the host credential service this package consumes. The real
 * provider is resolved per request through the process environment and the
 * managed credential document in that priority, exactly as every other
 * credential reference in the harness is.
 */
export interface CredentialResolver {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>;
}

/**
 * Resolve the API token for one Buildkite profile: the credential the profile
 * stores it under — entered on the Sandboxes page, and answered by the host
 * credential service from the process environment and the managed
 * `$DSH_HOME/.credentials.yaml` — then `BUILDKITE_API_TOKEN` in the process
 * environment as the deployment's fallback.
 *
 * The token must never reach a runner. Both sources are host-side; the broker
 * store, which is pushed into sandboxes, is not involved.
 */
export async function resolveBuildkiteToken(
  profile: BuildkiteProfile,
  credentials: CredentialResolver | undefined,
): Promise<string> {
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(
      credentialRef(defaultBuildkiteTokenCredential(profile.name)),
    );
    if (resolved !== undefined) {
      return resolved.value;
    }
  }
  const ambient = process.env[DEFAULT_BUILDKITE_TOKEN_ENV];
  if (ambient !== undefined && ambient.trim() !== "") {
    return ambient.trim();
  }
  throw new Error(
    `profile ${profile.name} needs a Buildkite API token: enter one in Settings → Sandboxes, or set ${DEFAULT_BUILDKITE_TOKEN_ENV} on the control plane`,
  );
}
