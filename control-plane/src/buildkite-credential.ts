/**
 * The credential reference a Buildkite token is stored under when the profile
 * does not name one. Shared by the host (which resolves the token) and the
 * Sandboxes page (which stores it), so both agree on the name without the
 * settings wire having to carry a derived field. Derived from the profile name
 * so two profiles keep two tokens, and always prefixed so any profile name
 * yields a valid reference.
 */
export function defaultBuildkiteTokenCredential(profileName: string): string {
  const segment = profileName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `DSH_YAWN_BUILDKITE_${segment}_TOKEN`;
}
