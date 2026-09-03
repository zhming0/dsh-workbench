import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SessionRecord } from "./types.js";

interface StateFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

export class SessionStore {
  private state: StateFile = { version: 1, sessions: {} };
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
    await this.persist();
  }

  async delete(sessionId: string): Promise<void> {
    delete this.state.sessions[sessionId];
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
  return value as StateFile;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
