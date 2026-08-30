import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface BrokerFile {
  version: 1;
  secrets: Record<string, string>;
}

export interface BrokerOptions {
  path: string;
}

/** Durable authority stays on the host; only current values are pushed to a runner. */
export class CredentialBroker {
  private state: BrokerFile = { version: 1, secrets: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrokerOptions) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    await this.refresh();
  }

  /** Pick up changes made by the companion CLI before the next command runs. */
  async refresh(): Promise<void> {
    await this.writeChain;
    try {
      this.state = parseBrokerFile(
        JSON.parse(await readFile(this.options.path, "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) this.state = { version: 1, secrets: {} };
      else throw error;
    }
  }

  secrets(): Record<string, string> {
    return { ...this.state.secrets };
  }

  secretNames(): string[] {
    return Object.keys(this.state.secrets).sort();
  }

  async setSecret(name: string, value: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid environment variable name: ${name}`);
    }
    this.state.secrets[name] = value;
    await this.persist();
  }

  async deleteSecret(name: string): Promise<void> {
    delete this.state.secrets[name];
    await this.persist();
  }

  /**
   * A GITHUB_TOKEN secret doubles as the github.com credential, so pasting a
   * token (fine-grained PAT or `gh auth token`) is the whole GitHub setup.
   */
  async gitCredentials(
    repositoryUrl: string,
  ): Promise<Array<{ host: string; username: string; password: string }>> {
    const host = repositoryHost(repositoryUrl);
    if (host !== "github.com") return [];
    const token = this.state.secrets["GITHUB_TOKEN"];
    if (token === undefined) return [];
    return [{ host, username: "x-access-token", password: token }];
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.options.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.options.path);
    });
    return this.writeChain;
  }
}

function repositoryHost(url: string): string | undefined {
  const scpStyle = /^[^@]+@([^:]+):/.exec(url);
  if (scpStyle?.[1] !== undefined) return scpStyle[1].toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function normalizeRepositoryUrl(url: string): string {
  const scpStyle = /^git@github\.com:(.+)$/.exec(url);
  if (scpStyle?.[1] !== undefined) return `https://github.com/${scpStyle[1]}`;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "ssh:" &&
      parsed.hostname.toLowerCase() === "github.com"
    ) {
      return `https://github.com/${parsed.pathname.replace(/^\//, "")}`;
    }
  } catch {
    // Keep local paths and other Git URL forms unchanged.
  }
  return url;
}

function parseBrokerFile(value: unknown): BrokerFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("secrets" in value) ||
    typeof value.secrets !== "object" ||
    value.secrets === null
  ) {
    throw new Error("credential broker file has an unsupported format");
  }
  // Keep only the known fields so retired ones (like the removed device-flow
  // token) drop out of the file on the next write.
  return { version: 1, secrets: value.secrets as Record<string, string> };
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const testing = { repositoryHost };
