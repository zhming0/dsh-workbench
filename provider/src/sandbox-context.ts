/**
 * The session context note that names the sandbox-visible workspace.
 *
 * dsh's stock file-policy line renders the session cwd verbatim. This provider
 * registers the host-side anchor path as the Workspace, so that line tells the
 * agent about a path that only exists on the dsh host; inside the sandbox the
 * same files live under the sandbox workspace. This note is contributed right
 * after the policy line so the agent can resolve the workspace it actually
 * operates in.
 */
export function sandboxBoundaryText(
  workspace: string,
  cwd: string | undefined,
): string {
  const hostSide =
    cwd === undefined
      ? ""
      : ` dsh records it under the host-side path ${JSON.stringify(cwd)}, which does not exist inside the container.`;
  return (
    `This dsh session runs inside its own sandbox container, not on the dsh host. ` +
    `The session workspace is mounted at ${JSON.stringify(workspace)} inside that container.` +
    hostSide +
    ` The container is the boundary: file and shell operations run inside it and ` +
    `cannot reach the dsh host's filesystem. The host-side file policy line above ` +
    `describes dsh's host file sandbox, which this profile disables.`
  );
}
