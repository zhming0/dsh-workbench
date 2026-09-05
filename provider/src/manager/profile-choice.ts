import type { SessionProfileView } from "../session-profile-remote.js";
import type { SessionStore } from "../state-store.js";
import type { SandboxProfile } from "../types.js";

/**
 * The profile a session runs under: what the composer chip shows before the
 * first prompt, what a session without a sandbox is provisioned with, and the
 * lock that stops the choice once a sandbox exists.
 */
export class ProfileChoice {
  constructor(
    private readonly profiles: Record<string, SandboxProfile>,
    private readonly defaultProfile: string,
    private readonly store: SessionStore,
  ) {}

  /** Profile choices for the composer chip; `locked` once a sandbox exists. */
  view(sessionId: string): SessionProfileView {
    const record = this.store.get(sessionId);
    return {
      profiles: Object.values(this.profiles).map(({ name, backend }) => ({
        name,
        backend,
      })),
      selected:
        record === undefined ? this.pending(sessionId).name : record.profile,
      locked: record !== undefined,
    };
  }

  /** Pick a profile for a session that has no sandbox yet; answer the view. */
  async set(sessionId: string, profile: string): Promise<SessionProfileView> {
    if (this.profiles[profile] === undefined) {
      throw new Error(`unknown sandbox profile: ${profile}`);
    }
    if (this.store.get(sessionId) !== undefined) {
      throw new Error("this session already has a sandbox");
    }
    await this.store.setPendingProfile(sessionId, profile);
    return this.view(sessionId);
  }

  /** The profile a session without a sandbox would be provisioned with. */
  pending(sessionId: string): SandboxProfile {
    const name = this.store.pendingProfile(sessionId) ?? this.defaultProfile;
    const profile = this.profiles[name];
    if (profile === undefined) {
      throw new Error(
        `sandbox profile ${name} is no longer configured; pick another profile`,
      );
    }
    return profile;
  }
}
