import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SessionRecord } from "./types.js";

interface StateFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
  /**
   * Profile picked in the browser for a session that has no sandbox yet. The
   * choice moves onto the session record when the sandbox is provisioned.
   */
  pendingProfiles: Record<string, string>;
}

export class SessionStore {
  private state: StateFile = { version: 1, sessions: {}, pendingProfiles: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.state = parseState(parsed);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.state.sessions[sessionId];
  }

  values(): SessionRecord[] {
    return Object.values(this.state.sessions);
  }

  async set(record: SessionRecord): Promise<void> {
    this.state.sessions[record.sessionId] = record;
    delete this.state.pendingProfiles[record.sessionId];
    await this.persist();
  }

  async delete(sessionId: string): Promise<void> {
    delete this.state.sessions[sessionId];
    await this.persist();
  }

  pendingProfile(sessionId: string): string | undefined {
    return this.state.pendingProfiles[sessionId];
  }

  async setPendingProfile(sessionId: string, profile: string): Promise<void> {
    this.state.pendingProfiles[sessionId] = profile;
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    });
    return this.writeChain;
  }
}

function parseState(value: unknown): StateFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("sessions" in value) ||
    typeof value.sessions !== "object" ||
    value.sessions === null
  ) {
    throw new Error("sandbox session state has an unsupported format");
  }
  const pendingProfiles =
    "pendingProfiles" in value &&
    typeof value.pendingProfiles === "object" &&
    value.pendingProfiles !== null
      ? (value.pendingProfiles as Record<string, string>)
      : {};
  return {
    version: 1,
    sessions: value.sessions as Record<string, SessionRecord>,
    pendingProfiles,
  };
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
