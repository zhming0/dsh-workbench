import { isAbsolute, posix, relative, sep } from "node:path";

/**
 * Translate a path from the dsh session workspace to the matching path inside
 * its sandbox. Paths already inside the sandbox or outside the session
 * workspace are unchanged.
 */
export function pathInSandbox(
  path: string,
  sessionWorkspace: string | undefined,
  sandboxWorkspace: string,
): string {
  if (
    sessionWorkspace === undefined ||
    !isAbsolute(path) ||
    isInsideSandboxWorkspace(path, sandboxWorkspace)
  ) {
    return path;
  }

  const childPath = relative(sessionWorkspace, path);
  if (childPath === "") {
    return sandboxWorkspace;
  }
  if (
    childPath === ".." ||
    childPath.startsWith(`..${sep}`) ||
    isAbsolute(childPath)
  ) {
    return path;
  }

  return posix.join(sandboxWorkspace, ...childPath.split(sep));
}

export function isInsideSandboxWorkspace(
  path: string,
  sandboxWorkspace: string,
): boolean {
  if (!posix.isAbsolute(path)) {
    return false;
  }
  const childPath = posix.relative(sandboxWorkspace, path);
  return (
    childPath === "" ||
    (childPath !== ".." &&
      !childPath.startsWith("../") &&
      !posix.isAbsolute(childPath))
  );
}
