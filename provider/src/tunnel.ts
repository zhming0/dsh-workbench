import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { createWebSocketStream, WebSocketServer, type WebSocket } from "ws";

import { runnerClientForSocket, type RunnerClient } from "./runner-client.js";

/**
 * How the manager reaches a runner. Runners dial the host, so acquiring a
 * client means waiting for the runner's registration, never dialing out.
 */
export interface RunnerGateway {
  waitFor(sandboxId: string, timeoutMs: number): Promise<RunnerClient>;
  drop(sandboxId: string): void;
}

export interface TunnelServerOptions {
  port: number;
  bind?: string;
  /** Accepted registration tokens. Two entries allow a rolling rotation. */
  tokens: string[];
  log?: (message: string) => void;
}

/** The only path that upgrades; HOST_URL ends with it. */
export const TUNNEL_PATH = "/tunnel";
/** Answers 200 so an HTTP load balancer can health-check the port. */
export const HEALTH_PATH = "/healthz";
/** Request header naming the sandbox the runner claims to be. */
export const SANDBOX_ID_HEADER = "x-dsh-sandbox-id";

interface Registration {
  stream: Duplex;
  client: RunnerClient;
}

interface Waiter {
  resolve: (client: RunnerClient) => void;
  timer: NodeJS.Timeout;
}

const HEALTH_PROBE_TIMEOUT_MS = 10_000;

/**
 * Accepts runner-initiated tunnel connections. A runner opens a WebSocket at
 * /tunnel, presenting the shared registration token as a bearer token and
 * its sandbox ID in a header. Once upgraded, the WebSocket carries plain
 * HTTP/2 with the roles reversed: this side is the HTTP/2 client, the runner
 * is the server.
 *
 * The listener itself is plaintext. Being WebSocket rather than a raw socket
 * is what lets an HTTPS proxy or Ingress terminate TLS in front of it with
 * the same certificate the Web UI uses, so a runner outside the trust domain
 * dials wss:// through that proxy while runners inside it dial ws:// directly.
 */
export class TunnelServer implements RunnerGateway {
  private readonly server: Server;
  private readonly upgrades = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  private readonly registrations = new Map<string, Registration>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly tokenDigests: Buffer[];
  private readonly log: (message: string) => void;

  constructor(private readonly options: TunnelServerOptions) {
    if (options.tokens.length === 0 || options.tokens.some((t) => t === "")) {
      throw new Error("the tunnel needs at least one non-empty token");
    }
    this.tokenDigests = options.tokens.map(digest);
    this.log = options.log ?? (() => {});
    this.server = createServer((request, response) =>
      this.handleRequest(request, response),
    );
    this.server.on("upgrade", (request, socket, head) =>
      this.handleUpgrade(request, socket, head),
    );
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.bind, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  /** The bound port; useful when constructed with port 0 in tests. */
  port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("tunnel server is not listening");
    }
    return address.port;
  }

  async close(): Promise<void> {
    for (const waiterSet of this.waiters.values()) {
      for (const waiter of waiterSet) {
        clearTimeout(waiter.timer);
      }
    }
    this.waiters.clear();
    for (const registration of this.registrations.values()) {
      registration.stream.destroy();
    }
    this.registrations.clear();
    this.upgrades.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  waitFor(sandboxId: string, timeoutMs: number): Promise<RunnerClient> {
    const existing = this.registrations.get(sandboxId);
    if (existing !== undefined && !existing.stream.destroyed) {
      return Promise.resolve(existing.client);
    }
    return new Promise((resolve, reject) => {
      const waiterSet = this.waiters.get(sandboxId) ?? new Set<Waiter>();
      this.waiters.set(sandboxId, waiterSet);
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          waiterSet.delete(waiter);
          reject(
            new Error(
              `runner ${sandboxId} did not register within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      waiter.timer.unref();
      waiterSet.add(waiter);
    });
  }

  drop(sandboxId: string): void {
    const registration = this.registrations.get(sandboxId);
    if (registration === undefined) {
      return;
    }
    this.registrations.delete(sandboxId);
    registration.stream.destroy();
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (request.url === HEALTH_PATH) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    socket.on("error", () => {});
    if (request.url !== TUNNEL_PATH) {
      reject(socket, 404, "not found");
      return;
    }
    const hello = parseHello(request);
    if (hello === undefined) {
      reject(socket, 400, "malformed handshake");
      return;
    }
    if (
      !this.tokenDigests.some((d) => timingSafeEqual(d, digest(hello.token)))
    ) {
      this.log(`tunnel: rejected runner ${hello.sandboxId}: bad token`);
      reject(socket, 401, "invalid registration token");
      return;
    }
    const existing = this.registrations.get(hello.sandboxId);
    if (existing !== undefined && !existing.stream.destroyed) {
      // A second live registration for one sandbox is either a runner bug or
      // an in-sandbox attacker trying to impersonate another session.
      this.log(
        `tunnel: rejected duplicate registration for ${hello.sandboxId}`,
      );
      reject(socket, 409, "sandbox is already registered");
      return;
    }
    request.socket.setNoDelay(true);
    this.upgrades.handleUpgrade(request, socket, head, (ws) => {
      this.register(hello.sandboxId, ws);
    });
  }

  private register(sandboxId: string, ws: WebSocket): void {
    const stream = createWebSocketStream(ws);
    stream.on("error", () => {});
    const registration: Registration = {
      stream,
      client: runnerClientForSocket(stream),
    };
    this.registrations.set(sandboxId, registration);
    stream.on("close", () => {
      if (this.registrations.get(sandboxId) === registration) {
        this.registrations.delete(sandboxId);
        this.log(`tunnel: runner ${sandboxId} disconnected`);
      }
    });
    this.log(`tunnel: runner ${sandboxId} registered`);

    // Start the reversed HTTP/2 session now instead of on the first RPC. An
    // unclaimed warm runner may wait far longer than the ten seconds Go's
    // HTTP/2 server allows for the client preface, and a stream without a
    // session never reads, so the host would also miss the peer closing and
    // reject every redial as a duplicate. The probe's session then keeps
    // keepalive pings flowing both ways.
    registration.client
      .health({ timeoutMs: HEALTH_PROBE_TIMEOUT_MS })
      .catch(() => {
        this.log(
          `tunnel: dropped runner ${sandboxId}: initial health probe failed`,
        );
        stream.destroy();
      });

    const waiterSet = this.waiters.get(sandboxId);
    if (waiterSet !== undefined) {
      this.waiters.delete(sandboxId);
      for (const waiter of waiterSet) {
        clearTimeout(waiter.timer);
        waiter.resolve(registration.client);
      }
    }
  }
}

function parseHello(
  request: IncomingMessage,
): { sandboxId: string; token: string } | undefined {
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const sandboxId = request.headers[SANDBOX_ID_HEADER];
  if (typeof sandboxId !== "string" || token === "") {
    return undefined;
  }
  if (sandboxId.length === 0 || sandboxId.length > 256) {
    return undefined;
  }
  return { sandboxId, token };
}

/** Answer the upgrade request with a plain HTTP error and hang up. */
function reject(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
      "content-type: text/plain\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      "connection: close\r\n\r\n" +
      body,
  );
}

/** Hashing makes unequal-length secrets comparable in constant time. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
