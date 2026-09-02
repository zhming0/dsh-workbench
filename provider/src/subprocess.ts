import { PassThrough, Writable, type Readable } from "node:stream";
import { basename, isAbsolute } from "node:path";

import {
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type { Context } from "@deepseek-ai/cordis";

import type { RunnerClient } from "./runner-client.js";
import { isInsideSandboxWorkspace, pathInSandbox } from "./sandbox-path.js";

export class SandboxSubprocessRuntime extends SubprocessRuntime {
  static inject = ["sandboxManager", "agents"];
  private readonly live = new Set<RemoteProcess>();

  constructor(ctx: Context) {
    super(ctx);
    ctx.effect(() => async () => {
      for (const process of this.live) process.terminate();
      await Promise.allSettled([...this.live].map((process) => process.done));
    });
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const client = await this.ctx.sandboxManager.clientForCurrentAgent();
    const response = await client.resolveExecutable(
      { command, env: { ...env } },
      signal === undefined ? {} : { signal },
    );
    return response.path;
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const process = new RemoteProcess(
      this.ctx.sandboxManager.clientForCurrentAgent(),
      spec,
      this.executionFrame(),
    );
    this.live.add(process);
    void process.done.finally(() => this.live.delete(process)).catch(() => {});
    return process;
  }

  /**
   * The two path frames one spawn translates between. Callers may speak
   * session coordinates (the dsh session workspace) because they were written
   * for the host world — the stock `tool-fs-search` row passes its session cwd
   * and a ripgrep path resolved from the host's own node_modules. The sandbox
   * is the execution world that has to answer, so the seam maps both onto the
   * sandbox the same way the shell seam maps its workdir.
   */
  private executionFrame(): ExecutionFrame {
    let sessionWorkspace: string | undefined;
    try {
      sessionWorkspace = this.ctx.agents.requireInitiator().session.header.cwd;
    } catch {
      // No foreground agent: nothing names session coordinates to translate.
    }
    return {
      sessionWorkspace,
      sandboxWorkspace: this.ctx.sandboxManager.workspace,
    };
  }

  async spawnTerminal(
    _spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> {
    throw new Error(
      "interactive terminals are not supported by dsh-sandbox Milestone 1",
    );
  }
}

/** The path frames one spawn translates between (see {@link SandboxSubprocessRuntime.executionFrame}). */
interface ExecutionFrame {
  readonly sessionWorkspace: string | undefined;
  readonly sandboxWorkspace: string;
}

class RemoteProcess implements SubprocessHandle {
  private processId = -1;
  private readonly controller = new AbortController();
  private readonly stdoutPipe: PassThrough | undefined;
  private readonly stderrPipe: PassThrough | undefined;
  private readonly stdoutCollection: CollectedBuffer | undefined;
  private readonly stderrCollection: CollectedBuffer | undefined;
  readonly stdin: Writable | undefined;
  readonly done: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;

  constructor(
    client: Promise<RunnerClient>,
    private readonly spec: SubprocessSpawnSpec,
    private readonly frame: ExecutionFrame,
  ) {
    this.stdin =
      spec.stdio.stdin === "pipe" ? new UnsupportedStdin() : undefined;
    this.stdoutPipe =
      spec.stdio.stdout === "pipe" ? new PassThrough() : undefined;
    this.stderrPipe =
      spec.stdio.stderr === "pipe" ? new PassThrough() : undefined;
    this.stdoutCollection =
      typeof spec.stdio.stdout === "object"
        ? new CollectedBuffer(spec.stdio.stdout.maxBytes)
        : undefined;
    this.stderrCollection =
      typeof spec.stdio.stderr === "object"
        ? new CollectedBuffer(spec.stdio.stderr.maxBytes)
        : undefined;
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) this.controller.abort(spec.signal.reason);
      else
        spec.signal.addEventListener(
          "abort",
          () => this.controller.abort(spec.signal!.reason),
          { once: true },
        );
    }
    this.done = this.run(client);
  }

  get pid(): number {
    return this.processId;
  }

  get stdout(): Readable | undefined {
    return this.stdoutPipe;
  }

  get stderr(): Readable | undefined {
    return this.stderrPipe;
  }

  get collected() {
    return {
      ...(this.stdoutCollection === undefined
        ? {}
        : { stdout: this.stdoutCollection }),
      ...(this.stderrCollection === undefined
        ? {}
        : { stderr: this.stderrCollection }),
    };
  }

  terminate(): void {
    this.controller.abort(new Error("process terminated"));
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) {
      await this.done.catch(() => {});
      return true;
    }
    if (signal.aborted) return false;
    return Promise.race([
      this.done.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      ),
    ]);
  }

  private async run(
    pendingClient: Promise<RunnerClient>,
  ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    const client = await pendingClient;
    const environment = Object.fromEntries(
      Object.entries(this.spec.env ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const stdin =
      typeof this.spec.stdio.stdin === "object"
        ? new TextEncoder().encode(this.spec.stdio.stdin.data)
        : new Uint8Array();
    const argv = await this.canonicalExecutable(
      this.spec.argv,
      client,
      environment,
    );
    const stream = client.exec(
      {
        argv,
        cwd: this.translatedWorkdir(),
        env: environment,
        stdin,
      },
      { signal: this.controller.signal },
    );
    try {
      for await (const response of stream) {
        if (response.event.case === "started")
          this.processId = Number(response.event.value.pid);
        else if (response.event.case === "stdout")
          this.writeOutput("stdout", response.event.value);
        else if (response.event.case === "stderr")
          this.writeOutput("stderr", response.event.value);
        else if (response.event.case === "exited") {
          return {
            exitCode:
              response.event.value.signal === ""
                ? response.event.value.exitCode
                : null,
            signal:
              response.event.value.signal === ""
                ? null
                : (response.event.value.signal as NodeJS.Signals),
          };
        }
      }
      throw new Error("runner exec stream ended without an exit status");
    } finally {
      this.stdoutPipe?.end();
      this.stderrPipe?.end();
    }
  }

  /**
   * The spawn's workdir in sandbox coordinates. Callers that already speak
   * sandbox coordinates are unchanged; a session-frame cwd — the stock tool
   * rows pass `session.header.cwd` — maps onto the sandbox workspace, where
   * this process actually runs.
   */
  private translatedWorkdir(): string {
    return pathInSandbox(
      this.spec.cwd,
      this.frame.sessionWorkspace,
      this.frame.sandboxWorkspace,
    );
  }

  /**
   * Map argv[0] onto the sandbox execution world when it names a host path.
   * An absolute path outside the sandbox workspace cannot exist there — a
   * packaged host binary such as `@vscode/ripgrep`'s ripgrep has no counterpart
   * at the same path — so resolve it against the sandbox's own lookup: first
   * the literal path (callers already speaking sandbox coordinates hit this),
   * then the basename, which resolves to the sandbox's own build of the same
   * tool. When neither resolves, keep the original so the runner reports the
   * failure it always did.
   */
  private async canonicalExecutable(
    argv: readonly string[],
    client: RunnerClient,
    environment: Record<string, string>,
  ): Promise<string[]> {
    const [executable] = argv;
    if (
      executable === undefined ||
      !isAbsolute(executable) ||
      isInsideSandboxWorkspace(executable, this.frame.sandboxWorkspace)
    ) {
      return [...argv];
    }
    for (const candidate of [executable, basename(executable)]) {
      try {
        const resolved = await client.resolveExecutable({
          command: candidate,
          env: { ...environment },
        });
        return [resolved.path, ...argv.slice(1)];
      } catch {
        // Try the next candidate; falling through keeps the original argv[0].
      }
    }
    return [...argv];
  }

  private writeOutput(stream: "stdout" | "stderr", chunk: Uint8Array): void {
    const mode = this.spec.stdio[stream];
    if (mode === "inherit")
      (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
    else if (mode === "pipe")
      (stream === "stdout" ? this.stdoutPipe : this.stderrPipe)?.write(chunk);
    else
      (stream === "stdout"
        ? this.stdoutCollection
        : this.stderrCollection
      )?.append(chunk);
  }
}

class UnsupportedStdin extends Writable {
  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(
      new Error("streaming stdin requires the deferred interactive transport"),
    );
  }
}

class CollectedBuffer implements SubprocessOutputReader {
  private tail = new Uint8Array();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.tail.byteLength + chunk.byteLength);
    joined.set(this.tail);
    joined.set(chunk, this.tail.byteLength);
    this.totalBytes += chunk.byteLength;
    this.tail = joined.subarray(Math.max(0, joined.byteLength - this.maxBytes));
  }

  readFrom(fromByte: number) {
    const tailStart = this.totalBytes - this.tail.byteLength;
    const lossy = fromByte < tailStart;
    const offset = lossy ? 0 : Math.max(0, fromByte - tailStart);
    return {
      text: new TextDecoder().decode(this.tail.subarray(offset)),
      nextOffset: this.totalBytes,
      lossy,
    };
  }
}

export const testing = { CollectedBuffer };
export default SandboxSubprocessRuntime;
