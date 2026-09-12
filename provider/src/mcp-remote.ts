import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

import type { McpServerEntry } from "./mcp-store.js";

export type McpServerStatus = "connected" | "starting" | "error" | "disabled";

/** Read-only browser view of one configured server. Never carries the token. */
export interface McpServerView {
  serverName: string;
  url: string;
  enabled: boolean;
  hasToken: boolean;
  status: McpServerStatus;
  toolCount: number;
  error?: string;
}

export interface McpTestResult {
  ok: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Browser CRUD surface for remote MCP servers. Tokens flow browser→host only;
 * every method answers with the updated view list, never a token.
 * The namespace map declaration lives in remote-contributions.ts.
 */
export interface SandboxMcpRemote {
  listMcpServers(): Promise<RemoteResult<McpServerView[]>>;
  setMcpServer(entry: McpServerEntry): Promise<RemoteResult<McpServerView[]>>;
  deleteMcpServer(serverName: string): Promise<RemoteResult<McpServerView[]>>;
  testMcpServer(entry: McpServerEntry): Promise<RemoteResult<McpTestResult>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("expected a string");
    }
    return value;
  },
};

const entrySchema: TypertSchema<McpServerEntry> = {
  parse(value: unknown): McpServerEntry {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("expected an MCP server entry");
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!["serverName", "url", "token", "enabled"].includes(key)) {
        throw new TypeError(`unexpected MCP server entry field: ${key}`);
      }
    }
    if (typeof record.serverName !== "string") {
      throw new TypeError(
        "expected an MCP server entry with a string serverName",
      );
    }
    if (typeof record.url !== "string") {
      throw new TypeError("expected an MCP server entry with a string url");
    }
    if (record.token !== undefined && typeof record.token !== "string") {
      throw new TypeError("expected an MCP server entry with a string token");
    }
    if (typeof record.enabled !== "boolean") {
      throw new TypeError(
        "expected an MCP server entry with a boolean enabled",
      );
    }
    const entry: McpServerEntry = {
      serverName: record.serverName,
      url: record.url,
      enabled: record.enabled,
    };
    return record.token === undefined
      ? entry
      : { ...entry, token: record.token };
  },
};

const statuses: readonly McpServerStatus[] = [
  "connected",
  "starting",
  "error",
  "disabled",
];

const viewSchema: TypertSchema<McpServerView> = {
  parse(value: unknown): McpServerView {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("expected an MCP server view");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.serverName !== "string" ||
      typeof record.url !== "string" ||
      typeof record.enabled !== "boolean" ||
      typeof record.hasToken !== "boolean" ||
      !statuses.includes(record.status as McpServerStatus) ||
      typeof record.toolCount !== "number" ||
      (record.error !== undefined && typeof record.error !== "string")
    ) {
      throw new TypeError("expected an MCP server view");
    }
    return value as McpServerView;
  },
};

const viewsSchema: TypertSchema<McpServerView[]> = {
  parse(value: unknown): McpServerView[] {
    if (!Array.isArray(value)) {
      throw new TypeError("expected an array of MCP server views");
    }
    return (value as unknown[]).map((entry) => viewSchema.parse(entry));
  },
};

const testResultSchema: TypertSchema<McpTestResult> = {
  parse(value: unknown): McpTestResult {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("expected an MCP test result");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.ok !== "boolean" ||
      typeof record.toolCount !== "number" ||
      (record.error !== undefined && typeof record.error !== "string")
    ) {
      throw new TypeError("expected an MCP test result");
    }
    return value as McpTestResult;
  },
};

function describe(
  method: string,
  parameters: Array<{ name: string; schema: TypertSchema }>,
  result: TypertSchema,
): InvocationDescriptor {
  const id = `@zhming0/dsh-workbench#sandboxManager/${method}`;
  return {
    id,
    service: "sandboxManager",
    namespace: "sandboxManager",
    method,
    invocation: { kind: "direct" },
    parameters: parameters.map(({ name, schema }) => ({
      name,
      wire: name,
      source: "json",
      codec: {
        mode: "strict",
        typeSymbol: `${id}:${name}`,
        schema,
      },
    })),
    result: { mode: "strict", typeSymbol: `${id}:result`, schema: result },
  };
}

export const sandboxMcpDescriptors: InvocationDescriptor[] = [
  describe("listMcpServers", [], viewsSchema),
  describe(
    "setMcpServer",
    [{ name: "entry", schema: entrySchema }],
    viewsSchema,
  ),
  describe(
    "deleteMcpServer",
    [{ name: "serverName", schema: stringSchema }],
    viewsSchema,
  ),
  describe(
    "testMcpServer",
    [{ name: "entry", schema: entrySchema }],
    testResultSchema,
  ),
];
