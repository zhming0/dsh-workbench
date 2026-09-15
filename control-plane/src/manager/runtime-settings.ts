import type { ResolvedRuntime } from "../config.js";
import type { SandboxProfile } from "../types.js";

/**
 * The slice of sandbox-manager settings that can change while the host runs.
 * The manager re-resolves it from the settings service after every committed
 * change; the idle scheduler and the lifecycle read through this holder, so
 * new timers apply to the next armed countdown and the next hibernation
 * without restarting anything.
 */
export class RuntimeSettings {
  private current: ResolvedRuntime;

  constructor(initial: ResolvedRuntime) {
    this.current = initial;
  }

  get profiles(): Record<string, SandboxProfile> {
    return this.current.profiles;
  }

  get defaultProfile(): string | undefined {
    return this.current.defaultProfile;
  }

  get idleMs(): number {
    return this.current.idleMs;
  }

  get expiresAfterMs(): number {
    return this.current.expiresAfterMs;
  }

  /**
   * Swap in the next resolved slice. Answers whether the profile map changed,
   * because that is the change whose reaction is expensive: rebuilding
   * backends. Timer changes need no reaction beyond this holder.
   */
  apply(next: ResolvedRuntime): boolean {
    const profilesChanged = !sameProfiles(this.current.profiles, next.profiles);
    this.current = next;
    return profilesChanged;
  }
}

/** Profiles are plain data built in a fixed field order, so JSON is equality. */
function sameProfiles(
  a: Record<string, SandboxProfile>,
  b: Record<string, SandboxProfile>,
): boolean {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) {
    return false;
  }
  return names.every(
    (name) =>
      b[name] !== undefined &&
      JSON.stringify(a[name]) === JSON.stringify(b[name]),
  );
}
