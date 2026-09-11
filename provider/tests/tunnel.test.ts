import http2 from "node:http2";
import type { Duplex } from "node:stream";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { describe, expect, it } from "vitest";
import { createWebSocketStream, WebSocket } from "ws";

import { RunnerService } from "../src/gen/dsh/sandbox/v1/runner_pb.js";
import {
  HEALTH_PATH,
  SANDBOX_ID_HEADER,
  TUNNEL_PATH,
  TunnelServer,
} from "../src/tunnel.js";

describe("runner tunnel", () => {
  it("admits one runner per sandbox through the WebSocket handshake", async () => {
    const tunnel = new TunnelServer({ port: 0, tokens: ["good-token"] });
    await tunnel.listen();
    // Larger than one HTTP/2 DATA frame and one WebSocket fragment, so both
    // directions have to reassemble across messages.
    const bigFile = new Uint8Array(3 * 1024 * 1024).fill(0x41);
    let written = 0;
    const h2 = http2.createServer(
      connectNodeAdapter({
        routes: (router) =>
          router.service(RunnerService, {
            health: () => ({ sandboxId: "sandbox-one", setupComplete: true }),
            readFile: () => ({ content: bigFile }),
            writeFile: (request) => {
              written = request.content.length;
              return {};
            },
          }),
      }),
    );
    try {
      const port = tunnel.port();
      expect(await handshake(port, "sandbox-one", "bad-token")).toEqual({
        status: 401,
        body: "invalid registration token\n",
      });
      expect(
        await handshake(port, "sandbox-one", "good-token", "/elsewhere"),
      ).toEqual({ status: 404, body: "not found\n" });
      expect(await handshake(port, "", "good-token")).toEqual({
        status: 400,
        body: "malformed handshake\n",
      });

      // An accepted runner serves HTTP/2 over the WebSocket it opened.
      const { stream } = await openTunnel(port, "sandbox-one", "good-token");
      expect(stream).toBeDefined();
      h2.emit("connection", stream);
      const client = await tunnel.waitFor("sandbox-one", 5_000);
      const health = await client.health({ timeoutMs: 5_000 });
      expect(health.sandboxId).toBe("sandbox-one");
      const read = await client.readFile(
        { path: "/big", maxBytes: 0n },
        { timeoutMs: 5_000 },
      );
      expect(read.content.length).toBe(bigFile.length);
      await client.writeFile(
        { path: "/big", content: bigFile, guard: { case: undefined } },
        { timeoutMs: 5_000 },
      );
      expect(written).toBe(bigFile.length);

      // While that registration lives, a second one for the same sandbox is
      // refused; this blocks in-sandbox impersonation of another session.
      expect(await handshake(port, "sandbox-one", "good-token")).toEqual({
        status: 409,
        body: "sandbox is already registered\n",
      });

      // Dropping the registration lets the runner register again.
      tunnel.drop("sandbox-one");
      const again = await openTunnel(port, "sandbox-one", "good-token");
      expect(again.result).toEqual({ status: 101 });
      again.stream?.destroy();

      // A dead connection frees its registration without an explicit drop,
      // so a runner redialing after a broken tunnel is not rejected as a
      // duplicate.
      await expect
        .poll(() => handshake(port, "sandbox-one", "good-token"), {
          timeout: 5_000,
        })
        .toEqual({ status: 101 });
    } finally {
      await tunnel.close();
      h2.close();
    }
  });

  it("answers plain HTTP health checks without a registration", async () => {
    const tunnel = new TunnelServer({ port: 0, tokens: ["good-token"] });
    await tunnel.listen();
    try {
      const health = await fetch(
        `http://127.0.0.1:${tunnel.port()}${HEALTH_PATH}`,
      );
      expect(health.status).toBe(200);
      const other = await fetch(
        `http://127.0.0.1:${tunnel.port()}${TUNNEL_PATH}`,
      );
      expect(other.status).toBe(404);
    } finally {
      await tunnel.close();
    }
  });
});

type Handshake = { status: number; body?: string };

function openTunnel(
  port: number,
  sandboxId: string,
  token: string,
  path = TUNNEL_PATH,
): Promise<{ stream?: Duplex; result: Handshake }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        [SANDBOX_ID_HEADER]: sandboxId,
      },
    });
    ws.once("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        resolve({ result: { status: response.statusCode ?? 0, body } });
      });
    });
    ws.once("error", reject);
    ws.once("open", () => {
      resolve({ stream: createWebSocketStream(ws), result: { status: 101 } });
    });
  });
}

async function handshake(
  port: number,
  sandboxId: string,
  token: string,
  path?: string,
): Promise<Handshake> {
  const { stream, result } = await openTunnel(port, sandboxId, token, path);
  stream?.destroy();
  return result;
}
