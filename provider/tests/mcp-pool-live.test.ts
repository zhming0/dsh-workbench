import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpPool } from "../src/mcp-pool.js";
import { McpServerStore } from "../src/mcp-store.js";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";

/**
 * End-to-end coverage with the real `@deepseek-ai/dsh-mcp-client`: a local
 * Streamable HTTP server, the real dynamic mount, and the real tools registry
 * shape. The unit tests cover the reconcile logic with a fake mount; this one
 * proves the seam between them actually connects and publishes tools.
 */
function toolsPlugin(ctx: Context) {
  const registered = new Map<string, unknown>();
  ctx.provide("tools", {
    register(definition: { name: string }) {
      registered.set(definition.name, definition);
      return () => void registered.delete(definition.name);
    },
    schemas: (): ToolSchema[] =>
      [...registered.keys()].map((name) => ({ name }) as ToolSchema),
  });
}

function toWebRequest(req: IncomingMessage, body: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }
  const init: RequestInit = { method: req.method ?? "POST", headers };
  if (body !== "") {
    init.body = body;
  }
  return new Request(`http://127.0.0.1${req.url ?? "/"}`, init);
}

async function startMcpServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // A stateless transport serves exactly one request, so each gets a pair.
      // A stateless transport: no session id, one request per instance.
      const transport = new WebStandardStreamableHTTPServerTransport();
      const mcp = new McpServer({ name: "workbench-test", version: "1.0.0" });
      mcp.registerTool(
        "drink",
        { description: "report the validation drink", inputSchema: {} },
        async () => ({ content: [{ type: "text" as const, text: "lapsang" }] }),
      );
      await mcp.connect(transport);
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const web = await transport.handleRequest(
        toWebRequest(req, Buffer.concat(chunks).toString()),
      );
      res.writeHead(web.status, Object.fromEntries(web.headers));
      res.end(Buffer.from(await web.arrayBuffer()));
      await transport.close();
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not bind a port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Mounting and discovery are asynchronous, so poll rather than sleep. */
async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for a mount");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("MCP pool against a real server", () => {
  let directory: string;
  let store: McpServerStore;
  let pool: McpPool;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-mcp-"));
    store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    const ctx = new Context();
    await ctx.plugin(toolsPlugin);
    pool = new McpPool({ ctx, store, warn: () => {} });
  });

  afterEach(async () => {
    await pool.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("connects, publishes tools, and removes them on dispose", async () => {
    const server = await startMcpServer();
    try {
      await store.upsert({
        serverName: "workbench",
        url: server.url,
        enabled: true,
      });

      await pool.sync();
      const connected = await waitFor(() => {
        const view = pool.views()[0];
        return view?.status === "connected" ? view : undefined;
      });
      expect(connected.toolCount).toBe(1);
      expect(connected.error).toBeUndefined();

      await pool.dispose();
      expect(pool.views()[0]?.status).toBe("disabled");
    } finally {
      await server.close();
    }
  }, 30_000);
});
