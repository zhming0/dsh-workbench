import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpServerStore } from "../src/mcp-store.js";

describe("MCP server store", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips entries sorted by name in an owner-only file", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert({
      serverName: "zeta",
      url: "https://zeta.example/mcp",
      enabled: true,
    });
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "alpha-token",
      enabled: true,
    });

    expect(store.list().map((entry) => entry.serverName)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(store.get("alpha")).toEqual({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    expect(store.tokenFor("alpha")).toBe("alpha-token");

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.list().map((entry) => entry.serverName)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(reopened.tokenFor("alpha")).toBe("alpha-token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("returns no token from list or get", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "alpha-token",
      enabled: true,
    });

    const [listed] = store.list();
    expect(listed).toEqual({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
    expect(store.get("alpha")).toEqual({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: true,
    });
  });

  it("keeps the saved token when an update omits it", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "first-token",
      enabled: true,
    });

    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      enabled: false,
    });
    expect(store.tokenFor("alpha")).toBe("first-token");
    expect(store.get("alpha")?.enabled).toBe(false);

    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "second-token",
      enabled: true,
    });
    expect(store.tokenFor("alpha")).toBe("second-token");

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.tokenFor("alpha")).toBe("second-token");
  });

  it("rejects invalid names and URLs", async () => {
    const store = new McpServerStore({ path: join(directory, "mcp.json") });
    await store.initialize();

    await expect(
      store.upsert({
        serverName: "bad name",
        url: "https://alpha.example/mcp",
        enabled: true,
      }),
    ).rejects.toThrow("invalid MCP server name");
    await expect(
      store.upsert({
        serverName: "alpha",
        url: "not a url",
        enabled: true,
      }),
    ).rejects.toThrow("invalid MCP server URL");
    await expect(
      store.upsert({
        serverName: "alpha",
        url: "ftp://alpha.example/mcp",
        enabled: true,
      }),
    ).rejects.toThrow("must use http or https");
    expect(store.list()).toEqual([]);
  });

  it("removes one entry and leaves the others", async () => {
    const path = join(directory, "mcp.json");
    const store = new McpServerStore({ path });
    await store.initialize();
    await store.upsert({
      serverName: "alpha",
      url: "https://alpha.example/mcp",
      token: "alpha-token",
      enabled: true,
    });
    await store.upsert({
      serverName: "beta",
      url: "https://beta.example/mcp",
      enabled: true,
    });

    await store.remove("alpha");
    expect(store.list().map((entry) => entry.serverName)).toEqual(["beta"]);
    expect(store.tokenFor("alpha")).toBeUndefined();

    const reopened = new McpServerStore({ path });
    await reopened.initialize();
    expect(reopened.list().map((entry) => entry.serverName)).toEqual(["beta"]);
  });
});
