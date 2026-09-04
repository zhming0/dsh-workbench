import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FileType } from "./gen/dsh/sandbox/v1/runner_pb.js";
import type { RunnerClient } from "./runner-client.js";

/** One workspace-relative path the "@" picker can offer. */
export interface FileIndexEntry {
  path: string;
  kind: "file" | "directory";
}

/** A workspace listing frozen at one point in time. */
export interface FileIndex {
  entries: FileIndexEntry[];
  /** The runner stopped walking at its entry cap, so the listing is partial. */
  truncated: boolean;
}

/** What the runner skips and how far it walks when it builds an index. */
export interface FileIndexOptions {
  excludedDirectories: readonly string[];
  maxEntries: number;
}

/** Walk one sandbox directory through the runner into a file index. */
export async function captureFileIndex(
  client: RunnerClient,
  root: string,
  options: FileIndexOptions,
): Promise<FileIndex> {
  const response = await client.tree({
    path: root,
    excludedDirectories: [...options.excludedDirectories],
    maxEntries: BigInt(options.maxEntries),
  });
  const entries: FileIndexEntry[] = [];
  for (const entry of response.entries) {
    if (entry.type === FileType.REGULAR) {
      entries.push({ path: entry.relativePath, kind: "file" });
    } else if (entry.type === FileType.DIRECTORY) {
      entries.push({ path: entry.relativePath, kind: "directory" });
    }
  }
  return { entries, truncated: response.truncated };
}

interface FileIndexFile extends FileIndex {
  version: 1;
}

/**
 * One JSON file per hibernated session. A hibernated workspace cannot change
 * (every write goes through a tool call, which first wakes the sandbox), so the
 * index taken as the sandbox suspends stays exact until the next wake.
 */
export class FileIndexStore {
  constructor(private readonly directory: string) {}

  async save(sessionId: string, index: FileIndex): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(sessionId);
    const temporary = `${path}.${process.pid}.tmp`;
    const file: FileIndexFile = { version: 1, ...index };
    await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
    await rename(temporary, path);
  }

  async load(sessionId: string): Promise<FileIndex | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathFor(sessionId), "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<FileIndexFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return undefined;
    }
    return { entries: parsed.entries, truncated: parsed.truncated === true };
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.pathFor(sessionId), { force: true });
  }

  private pathFor(sessionId: string): string {
    return join(this.directory, `${encodeURIComponent(sessionId)}.json`);
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
