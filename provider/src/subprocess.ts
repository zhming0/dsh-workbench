import { PassThrough, Writable, type Readable } from "node:stream";

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
    );
    this.live.add(process);
    void process.done.finally(() => this.live.delete(process)).catch(() => {});
    return process;
  }

  async spawnTerminal(
    _spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> {
    throw new Error(
      "interactive terminals are not supported by dsh-sandbox Milestone 1",
    );
  }
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
    const stream = client.exec(
      {
        argv: [...this.spec.argv],
        cwd: this.spec.cwd,
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
