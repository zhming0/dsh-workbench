import {
  createClient,
  type Client,
  type Interceptor,
} from "@connectrpc/connect";
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
import type { RunnerAuth } from "./types.js";

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

export function connectToRunner(
  baseUrl: string,
  sandboxId: string,
  auth: RunnerAuth,
): RunnerClient {
  const authorization: Interceptor = (next) => async (request) => {
    request.header.set(
      "authorization",
      `Bearer ${await auth.createToken(sandboxId)}`,
    );
    return next(request);
  };

  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "2",
    interceptors: [authorization],
    pingIntervalMs: 30_000,
    pingIdleConnection: true,
    pingTimeoutMs: 10_000,
  });

  return new RunnerClient(createClient(RunnerService, transport));
}
