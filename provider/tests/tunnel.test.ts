import http2 from "node:http2";
import { connect as netConnect, type Socket } from "node:net";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { describe, expect, it } from "vitest";

import { RunnerService } from "../src/gen/dsh/sandbox/v1/runner_pb.js";
import { TunnelServer } from "../src/tunnel.js";

describe("runner tunnel", () => {
  it("admits one runner per sandbox through the tunnel handshake", async () => {
    const tunnel = new TunnelServer({ port: 0, tokens: ["good-token"] });
    await tunnel.listen();
    const h2 = http2.createServer(
      connectNodeAdapter({
        routes: (router) =>
          router.service(RunnerService, {
            health: () => ({ sandboxId: "sandbox-one", setupComplete: true }),
          }),
      }),
    );
    try {
      const port = tunnel.port();
      expect(await handshake(port, "sandbox-one", "bad-token")).toEqual({
        ok: false,
        error: "invalid registration token",
      });

      // An accepted runner serves HTTP/2 over the socket it dialed with.
      const { socket, reply } = await openTunnel(
        port,
        "sandbox-one",
        "good-token",
      );
      expect(reply).toEqual({ ok: true });
      h2.emit("connection", socket);
      const client = await tunnel.waitFor("sandbox-one", 5_000);
      const health = await client.health({ timeoutMs: 5_000 });
      expect(health.sandboxId).toBe("sandbox-one");

      // While that registration lives, a second one for the same sandbox is
      // refused; this blocks in-sandbox impersonation of another session.
      expect(await handshake(port, "sandbox-one", "good-token")).toEqual({
        ok: false,
        error: "sandbox is already registered",
      });

      // Dropping the registration lets the runner register again.
      tunnel.drop("sandbox-one");
      const again = await openTunnel(port, "sandbox-one", "good-token");
      expect(again.reply).toEqual({ ok: true });
      again.socket.destroy();

      // A dead socket frees its registration without an explicit drop, so a
      // runner redialing after a broken tunnel is not rejected as a
      // duplicate.
      await expect
        .poll(() => handshake(port, "sandbox-one", "good-token"), {
          timeout: 5_000,
        })
        .toEqual({ ok: true });
    } finally {
      await tunnel.close();
      h2.close();
    }
  });
});

function openTunnel(
  port: number,
  sandboxId: string,
  token: string,
): Promise<{ socket: Socket; reply: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      socket.write(`${JSON.stringify({ sandboxId, token })}\n`);
    });
    socket.once("error", reject);
    socket.once("data", (chunk) => {
      // Anything past the reply line is the host's eager HTTP/2 preface;
      // pause and leave it buffered for whoever attaches an HTTP/2 server.
      socket.pause();
      const newline = chunk.indexOf(0x0a);
      const rest = chunk.subarray(newline + 1);
      if (rest.length > 0) {
        socket.unshift(rest);
      }
      resolve({
        socket,
        reply: JSON.parse(chunk.subarray(0, newline).toString("utf8")),
      });
    });
  });
}

async function handshake(
  port: number,
  sandboxId: string,
  token: string,
): Promise<unknown> {
  const { socket, reply } = await openTunnel(port, sandboxId, token);
  socket.destroy();
  return reply;
}
