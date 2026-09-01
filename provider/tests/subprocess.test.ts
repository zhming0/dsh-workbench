import { describe, expect, it } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";

import type { RunnerClient } from "../src/runner-client.js";
import { SandboxSubprocessRuntime } from "../src/subprocess.js";

const SESSION_WORKSPACE = "/data/.dsh-sandbox/workspace-anchors/owner-repo";
const SANDBOX_WORKSPACE = "/workspace/repository";
const PACKAGED_RG =
  "/data/.dsh/profiles/web/node_modules/@vscode/ripgrep/bin/rg";

interface ExecRequest {
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  stdin: Uint8Array;
}

interface FakeRunnerOptions {
  /** Absolute paths the fake runner's ResolveExecutable answers with itself. */
  existing?: string[];
  /** Bare names resolvable against the runner PATH, mapped to their paths. */
  onPath?: Record<string, string>;
}

function fakeRunnerClient(
  requests: ExecRequest[],
  resolves: string[],
  options: FakeRunnerOptions = {},
): RunnerClient {
  return {
    resolveExecutable({ command }: { command: string }) {
      resolves.push(command);
      if ((options.existing ?? []).includes(command))
        return Promise.resolve({ path: command });
      if ((options.onPath ?? {})[command] !== undefined)
        return Promise.resolve({ path: options.onPath![command]! });
      return Promise.reject(new Error("executable not found"));
    },
    // RemoteProcess consumes one request per exec and only needs the exit.
    async *exec(request: ExecRequest) {
      requests.push(request);
      yield { event: { case: "started", value: { pid: 7n } } };
      yield { event: { case: "exited", value: { exitCode: 0, signal: "" } } };
    },
  } as unknown as RunnerClient;
}

function runtimeWith(client: RunnerClient): SandboxSubprocessRuntime {
  const ctx = {
    ...new Context(),
    // Prototype methods (effect) do not survive the spread; the runtime only
    // registers its disposal effect, which a no-op stands in for here.
    effect: () => async () => {},
    sandboxManager: {
      clientForCurrentAgent: async () => client,
      workspace: SANDBOX_WORKSPACE,
    },
    agents: {
      requireInitiator: () => ({
        session: { header: { cwd: SESSION_WORKSPACE } },
      }),
    },
  };
  return new SandboxSubprocessRuntime(
    ctx as unknown as ConstructorParameters<typeof SandboxSubprocessRuntime>[0],
  );
}

function spawn(
  runtime: SandboxSubprocessRuntime,
  overrides: Partial<SubprocessSpawnSpec>,
): Promise<unknown> {
  const spec = {
    argv: ["/usr/local/bin/rg", "--files"],
    cwd: SANDBOX_WORKSPACE,
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ...overrides,
  } as SubprocessSpawnSpec;
  return runtime.spawn(spec).done;
}

describe("sandbox subprocess seam", () => {
  it("maps a session-frame workdir onto the sandbox workspace", async () => {
    const requests: ExecRequest[] = [];
    const client = fakeRunnerClient(requests, []);
    await spawn(runtimeWith(client), { cwd: `${SESSION_WORKSPACE}/nested` });
    expect(requests[0]?.cwd).toBe(`${SANDBOX_WORKSPACE}/nested`);
  });

  it("leaves sandbox-frame workdirs unchanged", async () => {
    const requests: ExecRequest[] = [];
    const client = fakeRunnerClient(requests, []);
    await spawn(runtimeWith(client), { cwd: `${SANDBOX_WORKSPACE}/nested` });
    expect(requests[0]?.cwd).toBe(`${SANDBOX_WORKSPACE}/nested`);
  });

  it("resolves a host-only executable to the sandbox build of the same tool", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves, {
      onPath: { rg: "/usr/local/bin/rg" },
    });
    await spawn(runtimeWith(client), {
      argv: [PACKAGED_RG, "--no-config", "--files"],
    });
    // The literal host path is tried first, then the basename.
    expect(resolves).toEqual([PACKAGED_RG, "rg"]);
    expect(requests[0]?.argv).toEqual([
      "/usr/local/bin/rg",
      "--no-config",
      "--files",
    ]);
  });

  it("keeps executables the sandbox already has at the given path", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves, {
      existing: ["/usr/local/bin/rg"],
    });
    await spawn(runtimeWith(client), {
      argv: ["/usr/local/bin/rg", "--files"],
    });
    expect(resolves).toEqual(["/usr/local/bin/rg"]);
    expect(requests[0]?.argv).toEqual(["/usr/local/bin/rg", "--files"]);
  });

  it("keeps the original executable when nothing resolves, so the runner reports the failure", async () => {
    const requests: ExecRequest[] = [];
    const client = fakeRunnerClient(requests, []);
    await spawn(runtimeWith(client), { argv: ["/host-only/tool", "--flag"] });
    expect(requests[0]?.argv).toEqual(["/host-only/tool", "--flag"]);
  });

  it("does not canonicalize executables inside the sandbox workspace", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves);
    await spawn(runtimeWith(client), {
      argv: [`${SANDBOX_WORKSPACE}/tool.sh`, "--flag"],
    });
    expect(resolves).toEqual([]);
    expect(requests[0]?.argv).toEqual([
      `${SANDBOX_WORKSPACE}/tool.sh`,
      "--flag",
    ]);
  });

  it("does not canonicalize bare or relative executables", async () => {
    const requests: ExecRequest[] = [];
    const resolves: string[] = [];
    const client = fakeRunnerClient(requests, resolves);
    await spawn(runtimeWith(client), { argv: ["rg", "--files"] });
    expect(resolves).toEqual([]);
    expect(requests[0]?.argv).toEqual(["rg", "--files"]);
  });
});
