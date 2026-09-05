import { FileType } from "../src/gen/dsh/sandbox/v1/runner_pb.js";
import type { RunnerClient } from "../src/runner-client.js";
import type { RunnerGateway } from "../src/tunnel.js";
import type {
  BackendReference,
  SandboxBackend,
  SandboxSpec,
} from "../src/types.js";

/** Test doubles shared by the SandboxManager suites. */
export class FakeWorkspaceRegistry {
  readonly creates: Array<{ path: string; title?: string }> = [];

  async create(path: string, title?: string) {
    this.creates.push(title === undefined ? { path } : { path, title });
    return { path };
  }

  list() {
    return this.creates.map(({ path, title }) => ({
      path,
      title: title ?? path,
    }));
  }
}

export interface FakeExec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export class FakeRunnerClient {
  setups = 0;
  healthy = true;
  secrets: Record<string, string> = {};
  readonly treeRequests: unknown[] = [];
  /** Every exec request, in order. */
  readonly execs: FakeExec[] = [];
  /** Replies for exec calls, consumed in order; the default succeeds silently. */
  readonly execReplies: Array<{ stdout?: string; exitCode?: number }> = [];
  readonly setupRequests: Array<{ revision: string }> = [];

  async health() {
    if (!this.healthy) {
      throw new Error("runner is unavailable");
    }
    return { sandboxId: "sandbox-one", setupComplete: this.setups > 0 };
  }

  async setSecrets(secrets: Record<string, string>) {
    this.secrets = secrets;
  }
  async setGitCredentials() {}

  async setup(request: { revision: string }) {
    this.setups += 1;
    this.setupRequests.push({ revision: request.revision });
    return { ran: this.setups === 1 };
  }

  async tree(request: unknown) {
    this.treeRequests.push(request);
    return {
      entries: [
        { relativePath: "src", type: FileType.DIRECTORY },
        { relativePath: "src/index.ts", type: FileType.REGULAR },
        { relativePath: "link", type: FileType.UNSPECIFIED },
      ],
      truncated: false,
    };
  }

  async *exec(request: FakeExec) {
    this.execs.push(request);
    const reply = this.execReplies.shift() ?? {};
    yield { event: { case: "started" as const, value: { pid: 1n } } };
    if (reply.stdout !== undefined) {
      yield {
        event: {
          case: "stdout" as const,
          value: new TextEncoder().encode(reply.stdout),
        },
      };
    }
    yield {
      event: {
        case: "exited" as const,
        value: { exitCode: reply.exitCode ?? 0, signal: "" },
      },
    };
  }
}

export class FakeBackend implements SandboxBackend {
  readonly name = "fake";
  readonly capabilities = { supportsHibernate: true };
  readonly client = new FakeRunnerClient();
  provisions = 0;
  hibernations = 0;
  wakes = 0;
  destroys = 0;
  expiries = 0;
  running = false;
  readonly repositoryUrls: string[] = [];

  async provision(spec: SandboxSpec) {
    this.provisions += 1;
    this.repositoryUrls.push(spec.repositoryUrl);
    this.running = true;
    return { sandboxId: "sandbox-one", reference: { id: "one" } };
  }

  async hibernate() {
    this.hibernations += 1;
    this.running = false;
  }

  async wake(reference: BackendReference) {
    this.wakes += 1;
    this.running = true;
    this.client.healthy = true;
    return { sandboxId: "sandbox-one", reference };
  }

  async destroy() {
    this.destroys += 1;
    this.running = false;
  }

  async expireAt() {
    this.expiries += 1;
  }

  async health() {
    return this.running;
  }
}

/** Stands in for the tunnel: every wait resolves to the fake runner. */
export function gatewayFor(backend: FakeBackend): RunnerGateway {
  return {
    waitFor: async () => backend.client as unknown as RunnerClient,
    drop() {},
  };
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
