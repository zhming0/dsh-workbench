import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_INSTRUCTIONS_BYTES = 65_536;

interface InstructionFile {
  version: 1;
  global: string;
  workspaces: Record<string, string>;
}

/** Durable UI-managed instruction layers, kept outside repository checkouts. */
export class InstructionStore {
  private state: InstructionFile = { version: 1, global: "", workspaces: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.state = parseInstructionFile(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  global(): string {
    return this.state.global;
  }

  workspace(repositoryUrl: string): string {
    return this.state.workspaces[repositoryUrl] ?? "";
  }

  async setGlobal(content: string): Promise<void> {
    const normalized = normalizeContent(content);
    for (const workspace of Object.values(this.state.workspaces)) {
      assertWithinLimit(normalized, workspace);
    }
    this.state.global = normalized;
    await this.persist();
  }

  async setWorkspace(repositoryUrl: string, content: string): Promise<void> {
    const normalized = normalizeContent(content);
    assertWithinLimit(this.state.global, normalized);
    if (normalized === "") {
      delete this.state.workspaces[repositoryUrl];
    } else {
      this.state.workspaces[repositoryUrl] = normalized;
    }
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

function normalizeContent(content: string): string {
  return content.trim() === "" ? "" : content;
}

function assertWithinLimit(global: string, workspace: string): void {
  if (
    Buffer.byteLength(global) + Buffer.byteLength(workspace) >
    MAX_INSTRUCTIONS_BYTES
  ) {
    throw new Error(
      "global and workspace instructions may total at most 65,536 UTF-8 bytes",
    );
  }
}

function parseInstructionFile(value: unknown): InstructionFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("global" in value) ||
    typeof value.global !== "string" ||
    !("workspaces" in value) ||
    typeof value.workspaces !== "object" ||
    value.workspaces === null ||
    Array.isArray(value.workspaces) ||
    Object.values(value.workspaces).some((entry) => typeof entry !== "string")
  ) {
    throw new Error("instruction file has an unsupported format");
  }
  const parsed: InstructionFile = {
    version: 1,
    global: value.global,
    workspaces: value.workspaces as Record<string, string>,
  };
  for (const workspace of Object.values(parsed.workspaces)) {
    assertWithinLimit(parsed.global, workspace);
  }
  return parsed;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
