import type { Context } from "@deepseek-ai/cordis";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";

import type { McpServerView, McpTestResult } from "./mcp-remote.js";
import type { McpServerEntry, McpServerStore } from "./mcp-store.js";
import { validateMcpServerEntry } from "./mcp-store.js";

/** A connection test may wait this long for the MCP handshake. */
const testTimeoutMs = 15_000;

export type McpClientConfig = mcpClient.StreamableHttpConfig;

/** The part of a Cordis fiber this pool uses: startup settlement and disposal. */
export interface McpMount {
  settled: PromiseLike<void>;
  dispose(): Promise<void>;
}

export interface McpPoolOptions {
  ctx: Context;
  store: McpServerStore;
  warn: (message: string) => void;
  /** Replacement client mount for tests; defaults to a real Cordis fiber. */
  mount?: (config: McpClientConfig) => McpMount;
}

interface LiveMount {
  entry: McpServerEntry;
  token: string | undefined;
  /**
   * Every fiber this entry started, in start order. A failed first mount can
   * be replaced by a reconnect mount, so the entry has to keep the first one
   * to dispose rather than dropping it in favour of its replacement.
   */
  fibers: Set<McpMount>;
  status: "starting" | "connected" | "error";
  error?: string;
  /** Set the moment the entry stops being wanted, before any await. */
  retired: boolean;
}

/**
 * Owns the live mcp-client mounts for the stored servers. One mount is one
 * Cordis fiber; reconciling against the store mounts, disposes, and remounts
 * as the configuration changes, without ever blocking on a server handshake.
 */
export class McpPool {
  private readonly ctx: Context;
  private readonly store: McpServerStore;
  private readonly warn: (message: string) => void;
  private readonly mount: (config: McpClientConfig) => McpMount;
  private readonly mounts = new Map<string, LiveMount>();
  /** Probe names in flight; they are not store entries, so sync ignores them. */
  private readonly probes = new Set<string>();
  private probeCount = 0;

  constructor(options: McpPoolOptions) {
    this.ctx = options.ctx;
    this.store = options.store;
    this.warn = options.warn;
    this.mount =
      options.mount ?? ((config) => mountClient(options.ctx, config));
  }

  /** Reconcile every live mount with the stored configuration. */
  async sync(): Promise<void> {
    await this.store.refresh();
    const wanted = new Map(
      this.store.list().map((entry) => [entry.serverName, entry]),
    );
    for (const [serverName, live] of [...this.mounts]) {
      const entry = wanted.get(serverName);
      if (
        entry === undefined ||
        !entry.enabled ||
        live.entry.url !== entry.url ||
        live.token !== this.store.tokenFor(serverName)
      ) {
        await this.unmount(serverName);
      }
    }
    for (const entry of wanted.values()) {
      if (!entry.enabled || this.mounts.has(entry.serverName)) {
        continue;
      }
      this.mountEntry(entry);
    }
  }

  /** Browser-facing status for every stored server, sorted by name. */
  views(): McpServerView[] {
    return this.store.list().map((entry) => {
      const live = this.mounts.get(entry.serverName);
      const toolCount =
        live === undefined ? 0 : this.toolCount(entry.serverName);
      // Tools in the registry outrank a recorded failure: a reconnect that
      // succeeded after the first handshake failed publishes its tools
      // without settling anything, and the row must stop reporting the old
      // error once that happens.
      const status =
        live === undefined
          ? "disabled"
          : toolCount > 0
            ? "connected"
            : live.status;
      return {
        serverName: entry.serverName,
        url: entry.url,
        enabled: entry.enabled,
        hasToken: this.store.tokenFor(entry.serverName) !== undefined,
        status,
        toolCount: status === "connected" ? toolCount : 0,
        ...(status === "error" && live?.error !== undefined
          ? { error: live.error }
          : {}),
      };
    });
  }

  /** Try one unsaved configuration; the probe never outlives the call. */
  async testConnection(entry: McpServerEntry): Promise<McpTestResult> {
    validateMcpServerEntry(entry);
    const token =
      entry.token === undefined || entry.token === ""
        ? this.store.tokenFor(entry.serverName)
        : entry.token;
    const probeName = this.probeName(entry.serverName);
    let fiber: McpMount | undefined;
    try {
      fiber = this.mount(buildConfig(probeName, entry.url, token, true));
      await withTimeout(fiber.settled, testTimeoutMs);
      return { ok: true, toolCount: this.toolCount(probeName) };
    } catch (reason) {
      return { ok: false, toolCount: 0, error: describe(reason) };
    } finally {
      this.probes.delete(probeName);
      if (fiber !== undefined) {
        try {
          await fiber.dispose();
        } catch (reason) {
          this.warn(
            `MCP test client for ${entry.serverName} failed to dispose: ${describe(reason)}`,
          );
        }
      }
    }
  }

  /** Dispose every live mount; one failure does not strand the others. */
  async dispose(): Promise<void> {
    const names = [...this.mounts.keys()];
    const results = await Promise.allSettled(
      names.map((serverName) => this.unmount(serverName)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.warn(
          `MCP client mount failed to dispose: ${describe(result.reason)}`,
        );
      }
    }
  }

  private mountEntry(entry: McpServerEntry): void {
    const token = this.store.tokenFor(entry.serverName);
    const live: LiveMount = {
      entry,
      token,
      fibers: new Set(),
      status: "starting",
      retired: false,
    };
    try {
      // The first mount rejects on a failed handshake, which is the only
      // signal that tells a dead server from a live one. Without it a broken
      // server would settle and be reported as connected with zero tools.
      this.startMount(
        live,
        buildConfig(entry.serverName, entry.url, token, true),
      );
    } catch (reason) {
      live.status = "error";
      live.error = describe(reason);
    }
    this.mounts.set(entry.serverName, live);
    const first = [...live.fibers][0];
    if (first === undefined) {
      return;
    }
    // Settlement must stay off the mounting path; a server handshake can take
    // the MCP SDK's full request timeout.
    void first.settled.then(
      () => {
        live.status = "connected";
      },
      (reason: unknown) => {
        live.status = "error";
        live.error = describe(reason);
        this.retryAfterFailure(entry.serverName, live);
      },
    );
  }

  /** Mount one fiber for an entry and record it for disposal. */
  private startMount(live: LiveMount, config: McpClientConfig): void {
    const fiber = this.mount(config);
    live.fibers.add(fiber);
  }

  /**
   * Replace a failed first mount with a reconnectable one so a server that is
   * briefly unreachable still recovers on its own. The replacement settles
   * immediately (it reports startup errors rather than rejecting), so the
   * failed status stays on screen instead of being overwritten by it.
   */
  private retryAfterFailure(serverName: string, live: LiveMount): void {
    if (live.retired || this.mounts.get(serverName) !== live) {
      return;
    }
    try {
      this.startMount(
        live,
        buildConfig(serverName, live.entry.url, live.token, false),
      );
    } catch (reason) {
      this.warn(
        `MCP client for ${serverName} could not start a reconnect mount: ${describe(reason)}`,
      );
    }
  }

  private async unmount(serverName: string): Promise<void> {
    const live = this.mounts.get(serverName);
    if (live === undefined) {
      return;
    }
    // Retire and clear before the await: a mount whose handshake fails while
    // this disposal is in flight must not start a replacement nothing owns.
    live.retired = true;
    this.mounts.delete(serverName);
    await Promise.allSettled([...live.fibers].map((fiber) => fiber.dispose()));
  }

  /**
   * mcp-client reserves a serverName process-wide, so a probe of an
   * already-mounted server — or of one another probe is testing — needs a
   * name of its own. Probe tools live for the test only and never enter the
   * server's real namespace.
   */
  private probeName(serverName: string): string {
    let name = `probe_${serverName}`.slice(0, 32);
    while (this.mounts.has(name) || this.probes.has(name)) {
      this.probeCount += 1;
      name = `probe_${this.probeCount.toString(36)}`;
    }
    this.probes.add(name);
    return name;
  }

  /** Count the tools the mount published, when the registry is reachable. */
  private toolCount(serverName: string): number {
    const tools = this.ctx.get("tools") as
      | { schemas(): Array<{ name: string }> }
      | undefined;
    if (tools === undefined) {
      return 0;
    }
    const prefix = `mcp__${serverName}__`;
    try {
      return tools.schemas().filter((tool) => tool.name.startsWith(prefix))
        .length;
    } catch {
      return 0;
    }
  }
}

function mountClient(ctx: Context, config: McpClientConfig): McpMount {
  const fiber = ctx.plugin(mcpClient, config);
  return {
    settled: fiber.then(() => undefined),
    dispose: () => fiber.dispose(),
  };
}

function buildConfig(
  serverName: string,
  url: string,
  token: string | undefined,
  failOnStartupError: boolean,
): McpClientConfig {
  return {
    transport: "streamable-http",
    serverName,
    url,
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    toolCallTimeoutMs: 60_000,
    failOnStartupError,
    reconnect: {
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    },
  };
}

function withTimeout<T>(value: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MCP connection test timed out after ${ms} ms`));
    }, ms);
    Promise.resolve(value).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
