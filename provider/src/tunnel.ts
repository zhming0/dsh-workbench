import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

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

interface Registration {
  socket: Socket;
  client: RunnerClient;
}

interface Waiter {
  resolve: (client: RunnerClient) => void;
  timer: NodeJS.Timeout;
}

const HANDSHAKE_LIMIT = 4096;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Accepts runner-initiated tunnel connections. After a one-line JSON
 * handshake carrying the shared registration token and the runner's sandbox
 * ID, the socket carries plain HTTP/2 with the roles reversed: this side is
 * the HTTP/2 client, the runner is the server.
 */
export class TunnelServer implements RunnerGateway {
  private readonly server: Server;
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
    this.server = createServer((socket) => this.handleConnection(socket));
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
    if (address === null || typeof address === "string")
      throw new Error("tunnel server is not listening");
    return address.port;
  }

  async close(): Promise<void> {
    for (const waiterSet of this.waiters.values()) {
      for (const waiter of waiterSet) clearTimeout(waiter.timer);
    }
    this.waiters.clear();
    for (const registration of this.registrations.values()) {
      registration.socket.destroy();
    }
    this.registrations.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  waitFor(sandboxId: string, timeoutMs: number): Promise<RunnerClient> {
    const existing = this.registrations.get(sandboxId);
    if (existing !== undefined && !existing.socket.destroyed) {
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
    if (registration === undefined) return;
    this.registrations.delete(sandboxId);
    registration.socket.destroy();
  }

  private handleConnection(socket: Socket): void {
    socket.setNoDelay(true);
    socket.on("error", () => {});
    const timer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > HANDSHAKE_LIMIT) {
          socket.off("data", onData);
          clearTimeout(timer);
          socket.destroy();
        }
        return;
      }
      socket.off("data", onData);
      clearTimeout(timer);
      socket.pause();
      const rest = buffered.subarray(newline + 1);
      this.finishHandshake(socket, buffered.subarray(0, newline), rest);
    };
    socket.on("data", onData);
  }

  private finishHandshake(socket: Socket, line: Buffer, rest: Buffer): void {
    const hello = parseHello(line);
    if (hello === undefined) {
      reject(socket, "malformed handshake");
      return;
    }
    if (
      !this.tokenDigests.some((d) => timingSafeEqual(d, digest(hello.token)))
    ) {
      this.log(`tunnel: rejected runner ${hello.sandboxId}: bad token`);
      reject(socket, "invalid registration token");
      return;
    }
    const existing = this.registrations.get(hello.sandboxId);
    if (existing !== undefined && !existing.socket.destroyed) {
      // A second live registration for one sandbox is either a runner bug or
      // an in-sandbox attacker trying to impersonate another session.
      this.log(
        `tunnel: rejected duplicate registration for ${hello.sandboxId}`,
      );
      reject(socket, "sandbox is already registered");
      return;
    }

    socket.write('{"ok":true}\n');
    // Bytes read past the handshake line belong to the HTTP/2 stream.
    if (rest.length > 0) socket.unshift(rest);
    const registration: Registration = {
      socket,
      client: runnerClientForSocket(socket),
    };
    this.registrations.set(hello.sandboxId, registration);
    socket.on("close", () => {
      if (this.registrations.get(hello.sandboxId) === registration) {
        this.registrations.delete(hello.sandboxId);
        this.log(`tunnel: runner ${hello.sandboxId} disconnected`);
      }
    });
    this.log(`tunnel: runner ${hello.sandboxId} registered`);

    // Start the reversed HTTP/2 session now instead of on the first RPC. An
    // unclaimed warm runner may wait far longer than the ten seconds Go's
    // HTTP/2 server allows for the client preface, and a socket without a
    // session never reads, so the host would also miss the peer closing and
    // reject every redial as a duplicate. The probe's session then keeps
    // keepalive pings flowing both ways.
    registration.client
      .health({ timeoutMs: HANDSHAKE_TIMEOUT_MS })
      .catch(() => {
        this.log(
          `tunnel: dropped runner ${hello.sandboxId}: initial health probe failed`,
        );
        socket.destroy();
      });

    const waiterSet = this.waiters.get(hello.sandboxId);
    if (waiterSet !== undefined) {
      this.waiters.delete(hello.sandboxId);
      for (const waiter of waiterSet) {
        clearTimeout(waiter.timer);
        waiter.resolve(registration.client);
      }
    }
  }
}

function parseHello(
  line: Buffer,
): { sandboxId: string; token: string } | undefined {
  try {
    const parsed = JSON.parse(line.toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { sandboxId, token } = parsed as Record<string, unknown>;
    if (typeof sandboxId !== "string" || typeof token !== "string")
      return undefined;
    if (sandboxId.length === 0 || sandboxId.length > 256) return undefined;
    if (token.length === 0) return undefined;
    return { sandboxId, token };
  } catch {
    return undefined;
  }
}

function reject(socket: Socket, message: string): void {
  socket.end(`${JSON.stringify({ ok: false, error: message })}\n`);
}

/** Hashing makes unequal-length secrets comparable in constant time. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
