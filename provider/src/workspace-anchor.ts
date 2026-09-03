import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { normalizeRepositoryUrl } from "./broker.js";

const ANCHORS_DIRECTORY = "workspace-anchors";
const METADATA_FILE = "repository.json";

interface AnchorMetadata {
  version: 1;
  repositoryUrl: string;
}

export interface RepositoryAnchor {
  path: string;
  repositoryUrl: string;
  title: string;
}

/** Create the stable host directory dsh uses as one repository's Workspace. */
export async function createRepositoryAnchor(
  stateDir: string,
  input: string,
): Promise<RepositoryAnchor> {
  const repositoryUrl = normalizeWorkspaceRepositoryUrl(input);
  const title = repositoryTitle(repositoryUrl);
  const root = anchorRoot(stateDir);
  const path = anchorPath(stateDir, repositoryUrl, title);

  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);

  const metadata: AnchorMetadata = { version: 1, repositoryUrl };
  const metadataPath = join(path, METADATA_FILE);
  let existing: AnchorMetadata;
  try {
    existing = await readAnchorMetadata(metadataPath);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    const temporary = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, metadataPath);
    } finally {
      await rm(temporary, { force: true });
    }
    existing = await readAnchorMetadata(metadataPath);
  }
  if (existing.repositoryUrl !== repositoryUrl) {
    throw new Error("repository anchor hash collision");
  }
  await chmod(metadataPath, 0o600);

  return { path: await realpath(path), repositoryUrl, title };
}

/** Resolve repository metadata only for a provider-managed anchor directory. */
export async function repositoryForAnchor(
  stateDir: string,
  cwd: string,
): Promise<string | undefined> {
  let root: string;
  let path: string;
  try {
    [root, path] = await Promise.all([
      realpath(anchorRoot(stateDir)),
      realpath(cwd),
    ]);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  const child = relative(root, path);
  if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
    return undefined;
  }
  if (child.includes("/") || child.includes("\\")) {
    return undefined;
  }

  let metadata: AnchorMetadata;
  try {
    metadata = await readAnchorMetadata(join(path, METADATA_FILE));
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  const expected = await realpath(
    anchorPath(
      stateDir,
      metadata.repositoryUrl,
      repositoryTitle(metadata.repositoryUrl),
    ),
  );
  if (expected !== path) {
    throw new Error("repository anchor metadata is invalid");
  }
  return metadata.repositoryUrl;
}

/** Normalize and validate a repository URL entered through the Web UI. */
export function normalizeWorkspaceRepositoryUrl(input: string): string {
  let repositoryUrl = normalizeRepositoryUrl(input.trim());
  if (repositoryUrl.length === 0 || /\s/.test(repositoryUrl)) {
    throw new Error("Enter a repository URL");
  }

  const scp = /^([^@/:]+)@([^/:]+):(.+)$/.exec(repositoryUrl);
  if (scp !== null) {
    const [, user, host, rawPath] = scp;
    if (rawPath!.includes("?") || rawPath!.includes("#")) {
      throw new Error("Repository URL must not contain a query or fragment");
    }
    const path = normalizeRepositoryPath(rawPath!);
    if (path.length === 0) {
      throw new Error("Repository URL has no path");
    }
    return `${user!}@${host!.toLowerCase()}:${path}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    throw new Error("Enter a valid repository URL");
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
    throw new Error("Repository URL must use HTTP, HTTPS, SSH, or Git");
  }
  if (parsed.password.length > 0) {
    throw new Error("Repository URL must not contain a password");
  }
  if (
    parsed.username.length > 0 &&
    ["http:", "https:", "git:"].includes(parsed.protocol)
  ) {
    throw new Error("Repository URL must not contain credentials");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error("Repository URL must not contain a query or fragment");
  }
  const path = normalizeRepositoryPath(parsed.pathname);
  if (path.length === 0) {
    throw new Error("Repository URL has no path");
  }
  parsed.pathname = `/${path}`;
  repositoryUrl = parsed.toString();
  return repositoryUrl.endsWith("/")
    ? repositoryUrl.slice(0, -1)
    : repositoryUrl;
}

export function repositoryTitle(repositoryUrl: string): string {
  let path: string;
  try {
    path = new URL(repositoryUrl).pathname;
  } catch {
    path = /^[^@]+@[^:]+:(.+)$/.exec(repositoryUrl)?.[1] ?? repositoryUrl;
  }
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const repository = parts.at(-1) ?? repositoryUrl;
  const owner = parts.at(-2);
  return owner === undefined ? repository : `${owner}/${repository}`;
}

function anchorRoot(stateDir: string): string {
  return resolve(stateDir, ANCHORS_DIRECTORY);
}

function anchorPath(
  stateDir: string,
  repositoryUrl: string,
  title: string,
): string {
  let host = "repository";
  try {
    host = new URL(repositoryUrl).hostname;
  } catch {
    host = /^[^@]+@([^:]+):/.exec(repositoryUrl)?.[1] ?? host;
  }
  const slug = `${host}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  const hash = createHash("sha256")
    .update(repositoryUrl)
    .digest("hex")
    .slice(0, 32);
  return join(anchorRoot(stateDir), `${slug || "repository"}-${hash}`);
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
}

async function readAnchorMetadata(path: string): Promise<AnchorMetadata> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("repositoryUrl" in value) ||
    typeof value.repositoryUrl !== "string" ||
    normalizeWorkspaceRepositoryUrl(value.repositoryUrl) !== value.repositoryUrl
  ) {
    throw new Error("repository anchor metadata has an unsupported format");
  }
  return value as AnchorMetadata;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
