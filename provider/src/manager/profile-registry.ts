import { DockerBackend } from "../backends/docker.js";
import { KasBackend } from "../backends/kas.js";
import type {
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
  private readonly backends: Map<string, SandboxBackend>;

  constructor(
    private readonly profiles: Record<string, SandboxProfile>,
    /** Replacement backends by profile name; a missing one gets built here. */
    replacements: Record<string, SandboxBackend> | undefined,
    registrationToken: string | undefined,
  ) {
    this.backends = new Map(
      Object.entries(profiles).map(([name, profile]) => [
        name,
        replacements?.[name] ?? createBackend(profile, registrationToken),
      ]),
    );
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

function createBackend(
  profile: SandboxProfile,
  registrationToken: string | undefined,
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
  const { name: _name, backend: _backend, ...options } = profile;
  return new KasBackend(options);
}

function orphanedRecordMessage(record: SessionRecord): string {
  return `session ${record.sessionId} has a ${record.backend} sandbox from profile ${record.profile}, which is no longer configured on that backend`;
}
