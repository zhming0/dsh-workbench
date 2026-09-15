import { BuildkiteBackend } from "../backends/buildkite.js";
import { DockerBackend } from "../backends/docker.js";
import { KasBackend } from "../backends/kas.js";
import { resolveBuildkiteToken } from "../buildkite-token.js";
import type {
  BuildkiteProfile,
  SandboxBackend,
  SandboxProfile,
  SessionRecord,
} from "../types.js";

/**
 * The configured sandbox profiles and the backends built from them. Answers
 * "which backend owns this record" in one place: a profile that was removed,
 * or renamed onto another backend, cannot interpret the record's reference.
 */
export class ProfileRegistry {
  private backends: Map<string, SandboxBackend>;
  private profiles: Record<string, SandboxProfile>;

  constructor(
    profiles: Record<string, SandboxProfile>,
    /** Replacement backends by profile name; a missing one gets built here. */
    private readonly replacements: Record<string, SandboxBackend> | undefined,
    private readonly registrationToken: string | undefined,
    /** Buildkite token resolution; defaults to the process environment. */
    private readonly buildkiteToken: (
      profile: BuildkiteProfile,
    ) => Promise<string> = (profile) =>
      resolveBuildkiteToken(profile, undefined),
  ) {
    this.profiles = profiles;
    this.backends = buildBackends(
      profiles,
      replacements,
      registrationToken,
      buildkiteToken,
    );
  }

  /**
   * Swap in the next resolved profiles, keeping a backend whose profile is
   * unchanged — backends hold clients and in-flight work — and building fresh
   * ones for profiles that were added or edited. Removed profiles drop out;
   * their sessions become orphaned records, as they do across a restart.
   *
   * Atomic: a profile whose backend cannot be built throws before anything is
   * swapped, so the previous set keeps serving.
   */
  update(profiles: Record<string, SandboxProfile>): void {
    const backends = new Map<string, SandboxBackend>();
    for (const [name, profile] of Object.entries(profiles)) {
      const existing = this.backends.get(name);
      // Profiles are plain data built in a fixed field order, so JSON
      // comparison is equality; an unchanged profile keeps its backend.
      const unchanged =
        existing !== undefined &&
        this.profiles[name] !== undefined &&
        JSON.stringify(this.profiles[name]) === JSON.stringify(profile);
      backends.set(
        name,
        unchanged
          ? existing
          : (this.replacements?.[name] ??
              createBackend(
                profile,
                this.registrationToken,
                this.buildkiteToken,
              )),
      );
    }
    this.profiles = profiles;
    this.backends = backends;
  }

  /** The resolved profile of one name, if it is still configured. */
  profile(name: string): SandboxProfile | undefined {
    return this.profiles[name];
  }

  /** The backend built for one profile name, if it is still configured. */
  backendOf(name: string): SandboxBackend | undefined {
    return this.backends.get(name);
  }

  /** The backend that owns a record's sandbox, or undefined when orphaned. */
  findBackend(record: SessionRecord): SandboxBackend | undefined {
    const backend = this.backends.get(record.profile);
    return backend?.name === record.backend ? backend : undefined;
  }

  /** findBackend, but a record this registry cannot serve fails loudly. */
  backendFor(record: SessionRecord): SandboxBackend {
    const backend = this.findBackend(record);
    if (backend === undefined) {
      throw new Error(orphanedRecordMessage(record));
    }
    return backend;
  }
}

function buildBackends(
  profiles: Record<string, SandboxProfile>,
  replacements: Record<string, SandboxBackend> | undefined,
  registrationToken: string | undefined,
  buildkiteToken: (profile: BuildkiteProfile) => Promise<string>,
): Map<string, SandboxBackend> {
  return new Map(
    Object.entries(profiles).map(([name, profile]) => [
      name,
      replacements?.[name] ??
        createBackend(profile, registrationToken, buildkiteToken),
    ]),
  );
}

function createBackend(
  profile: SandboxProfile,
  registrationToken: string | undefined,
  buildkiteToken: (profile: BuildkiteProfile) => Promise<string>,
): SandboxBackend {
  if (profile.backend === "docker") {
    const { name: _name, backend: _backend, ...options } = profile;
    // The caller resolved tokens before building backends; a development
    // Docker backend never reaches this without one.
    return new DockerBackend({
      ...options,
      registrationToken: registrationToken as string,
    });
  }
  if (profile.backend === "buildkite") {
    // The token resolves per request from the host credential service or the
    // process environment. It is not a broker secret: it must never reach a
    // runner.
    const { name: _name, backend: _backend, ...options } = profile;
    return new BuildkiteBackend({
      ...options,
      token: () => buildkiteToken(profile),
    });
  }
  const { name: _name, backend: _backend, ...options } = profile;
  return new KasBackend(options);
}

function orphanedRecordMessage(record: SessionRecord): string {
  return `session ${record.sessionId} has a ${record.backend} sandbox from profile ${record.profile}, which is no longer configured on that backend`;
}

/** Internals the test suite reaches into. */
export const testing = {
  createBackend: (
    profile: SandboxProfile,
    registrationToken: string | undefined,
  ) =>
    createBackend(profile, registrationToken, (p) =>
      resolveBuildkiteToken(p, undefined),
    ),
};
