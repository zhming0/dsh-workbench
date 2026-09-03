import type { Duplex } from "node:stream";

import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import {
  RunnerService,
  type EditFileRequest,
  type ExecRequest,
  type GitCredential,
  type ReadFileRequest,
  type ResolveExecutableRequest,
  type ResolvePathRequest,
  type SetupRequest,
  type StatRequest,
  type WriteFileRequest,
} from "./gen/dsh/sandbox/v1/runner_pb.js";

type GeneratedClient = Client<typeof RunnerService>;
type CallOptions = { signal?: AbortSignal; timeoutMs?: number };

/** A small facade keeps generated RPC details out of dsh capability adapters. */
export class RunnerClient {
  constructor(private readonly client: GeneratedClient) {}

  health(options?: CallOptions) {
    return this.client.health({}, options);
  }

  exec(request: Omit<ExecRequest, "$typeName">, options?: CallOptions) {
    return this.client.exec(request, options);
  }

  resolveExecutable(
    request: Omit<ResolveExecutableRequest, "$typeName">,
    options?: CallOptions,
  ) {
    return this.client.resolveExecutable(request, options);
  }

  resolvePath(
    request: Omit<ResolvePathRequest, "$typeName">,
    options?: CallOptions,
  ) {
    return this.client.resolvePath(request, options);
  }

  readFile(request: Omit<ReadFileRequest, "$typeName">, options?: CallOptions) {
    return this.client.readFile(request, options);
  }

  writeFile(
    request: Omit<WriteFileRequest, "$typeName">,
    options?: CallOptions,
  ) {
    return this.client.writeFile(request, options);
  }

  editFile(request: Omit<EditFileRequest, "$typeName">, options?: CallOptions) {
    return this.client.editFile(request, options);
  }

  stat(request: Omit<StatRequest, "$typeName">, options?: CallOptions) {
    return this.client.stat(request, options);
  }

  list(path: string, options?: CallOptions) {
    return this.client.list({ path }, options);
  }

  async setSecrets(secrets: Record<string, string>): Promise<void> {
    await this.client.setSecrets({ secrets });
  }

  async setGitCredentials(
    credentials: Omit<GitCredential, "$typeName">[],
  ): Promise<void> {
    await this.client.setGitCredentials({ credentials });
  }

  setup(request: Omit<SetupRequest, "$typeName">) {
    return this.client.setup(request);
  }
}

/**
 * Build a client speaking plain HTTP/2 over one runner-initiated tunnel
 * socket. The socket carries exactly one HTTP/2 session: when it closes, the
 * client is dead and the runner must register again.
 */
export function runnerClientForSocket(socket: Duplex): RunnerClient {
  let used = false;
  const transport = createConnectTransport({
    // The runner ignores the authority; requests never leave this socket.
    baseUrl: "http://dsh-runner.invalid",
    httpVersion: "2",
    nodeOptions: {
      createConnection: () => {
        if (used) {
          throw new Error("runner tunnel is closed");
        }
        used = true;
        return socket;
      },
    },
    pingIntervalMs: 30_000,
    pingIdleConnection: true,
    pingTimeoutMs: 10_000,
    // The default closes idle sessions after 15 minutes. This tunnel is
    // one-to-one with a registered runner and pings already detect a dead
    // path, so closing an idle-but-healthy tunnel would only force a
    // pointless re-registration. The cap is setTimeout's maximum delay.
    idleConnectionTimeoutMs: 2 ** 31 - 1,
  });

  return new RunnerClient(createClient(RunnerService, transport));
}
