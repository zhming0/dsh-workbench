import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** One remote Streamable HTTP MCP server. The token never leaves the host. */
export interface McpServerEntry {
  serverName: string;
  url: string;
  token?: string;
  enabled: boolean;
}

interface McpFile {
  version: 1;
  servers: McpServerEntry[];
}

export interface McpStoreOptions {
  path: string;
}

const serverNamePattern = /^[A-Za-z0-9_-]{1,32}$/;

/** Reject the two fields the mcp-client and the HTTP transport both depend on. */
export function validateMcpServerEntry(entry: McpServerEntry): void {
  if (!serverNamePattern.test(entry.serverName)) {
    throw new Error(
      `invalid MCP server name "${entry.serverName}": use 1-32 letters, digits, "_", or "-"`,
    );
  }
  const url = parseUrl(entry.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP server URL must use http or https: ${entry.url}`);
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`invalid MCP server URL: ${value}`);
  }
}

/** Owner-only durable MCP server configuration, mirroring the credential broker. */
export class McpServerStore {
  private state: McpFile = { version: 1, servers: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: McpStoreOptions) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    await this.refresh();
  }

  /** Pick up edits made outside the running host before the next reconcile. */
  async refresh(): Promise<void> {
    await this.writeChain;
    try {
      this.state = parseMcpFile(
        JSON.parse(await readFile(this.options.path, "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) {
        this.state = { version: 1, servers: [] };
      } else {
        throw error;
      }
    }
  }

  /** Every entry without its token, sorted by name for stable output. */
  list(): McpServerEntry[] {
    return sorted(this.state.servers).map(({ serverName, url, enabled }) => ({
      serverName,
      url,
      enabled,
    }));
  }

  /** One entry without its token; undefined when nothing is stored. */
  get(serverName: string): McpServerEntry | undefined {
    const entry = find(this.state.servers, serverName);
    if (entry === undefined) {
      return undefined;
    }
    return {
      serverName: entry.serverName,
      url: entry.url,
      enabled: entry.enabled,
    };
  }

  /** The one accessor that returns a token, for building a request header. */
  tokenFor(serverName: string): string | undefined {
    return find(this.state.servers, serverName)?.token;
  }

  /**
   * Store one entry. An omitted or empty token keeps the saved token, so the
   * browser can edit a server without ever receiving the value back.
   */
  async upsert(entry: McpServerEntry): Promise<void> {
    validateMcpServerEntry(entry);
    const kept = entry.token === undefined || entry.token === "";
    const token = kept ? this.tokenFor(entry.serverName) : entry.token;
    const stored: McpServerEntry =
      token === undefined
        ? {
            serverName: entry.serverName,
            url: entry.url,
            enabled: entry.enabled,
          }
        : {
            serverName: entry.serverName,
            url: entry.url,
            token,
            enabled: entry.enabled,
          };
    this.state = {
      version: 1,
      servers: [
        ...this.state.servers.filter(
          (candidate) => candidate.serverName !== entry.serverName,
        ),
        stored,
      ],
    };
    await this.persist();
  }

  async remove(serverName: string): Promise<void> {
    const servers = this.state.servers.filter(
      (candidate) => candidate.serverName !== serverName,
    );
    if (servers.length === this.state.servers.length) {
      return;
    }
    this.state = { version: 1, servers };
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(
      { version: 1, servers: sorted(this.state.servers) },
      null,
      2,
    )}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.options.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.options.path);
    });
    return this.writeChain;
  }
}

function find(
  servers: McpServerEntry[],
  serverName: string,
): McpServerEntry | undefined {
  return servers.find((entry) => entry.serverName === serverName);
}

function sorted(servers: McpServerEntry[]): McpServerEntry[] {
  // Plain code-unit order keeps the file and the API stable across locales.
  return [...servers].sort((left, right) =>
    left.serverName < right.serverName
      ? -1
      : left.serverName > right.serverName
        ? 1
        : 0,
  );
}

function parseMcpFile(value: unknown): McpFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("servers" in value) ||
    !Array.isArray(value.servers)
  ) {
    throw new Error("MCP server file has an unsupported format");
  }
  return { version: 1, servers: (value.servers as unknown[]).map(parseEntry) };
}

/** Keep only the known fields so retired ones drop out on the next write. */
function parseEntry(value: unknown): McpServerEntry {
  if (typeof value !== "object" || value === null) {
    throw new Error("MCP server file has an unsupported format");
  }
  const record = value as Record<string, unknown>;
  const { serverName, url, token, enabled } = record;
  if (
    typeof serverName !== "string" ||
    typeof url !== "string" ||
    (token !== undefined && typeof token !== "string") ||
    (enabled !== undefined && typeof enabled !== "boolean")
  ) {
    throw new Error("MCP server file has an unsupported format");
  }
  const entry: McpServerEntry = { serverName, url, enabled: enabled ?? true };
  return token === undefined ? entry : { ...entry, token };
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
