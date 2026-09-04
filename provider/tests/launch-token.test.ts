import type { IncomingMessage, ServerResponse } from "node:http";

import { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { describe, expect, it } from "vitest";

import * as launchToken from "../src/launch-token.js";

const TOKEN = "test-launch-token";

async function mountSignIn(): Promise<{ routes: WebRoute[]; ctx: Context }> {
  const ctx = new Context();
  const routes: WebRoute[] = [];
  ctx.provide("webServer", {
    register(route: WebRoute) {
      routes.push(route);
      return () => {
        routes.splice(routes.indexOf(route), 1);
      };
    },
  });
  ctx.provide("connection", {
    authenticatedUrl(baseUrl: string) {
      const url = new URL(baseUrl);
      url.pathname = "/";
      url.searchParams.set("token", TOKEN);
      return url.href;
    },
  });
  await ctx.plugin(launchToken);
  return { routes, ctx };
}

interface Reply {
  status: number;
  headers: Record<string, string>;
}

async function request(route: WebRoute, method: string): Promise<Reply> {
  const reply: Reply = { status: 0, headers: {} };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      reply.status = status;
      reply.headers = headers ?? {};
      return res;
    },
    end() {
      return res;
    },
  } as unknown as ServerResponse;
  await route.handler({ method } as IncomingMessage, res);
  return reply;
}

describe("launch-token route", () => {
  it("redirects GET /launch-token to the tokenized root, keeping the browser's authority", async () => {
    const { routes } = await mountSignIn();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ kind: "exact", path: "/launch-token" });

    const reply = await request(routes[0]!, "GET");
    expect(reply.status).toBe(303);
    expect(reply.headers["location"]).toBe(`/?token=${TOKEN}`);
    expect(reply.headers["cache-control"]).toBe("no-store");
  });

  it("refuses methods other than GET and HEAD", async () => {
    const { routes } = await mountSignIn();
    const reply = await request(routes[0]!, "POST");
    expect(reply.status).toBe(405);
    expect(reply.headers["allow"]).toBe("GET, HEAD");
  });

  it("removes the route when the plugin is disposed", async () => {
    const { routes, ctx } = await mountSignIn();
    await ctx.fiber.dispose();
    expect(routes).toHaveLength(0);
  });
});
