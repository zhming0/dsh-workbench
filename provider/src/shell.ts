import type { Context } from "@deepseek-ai/cordis";
import {
  ShellExecutor,
  type CollectedOutput,
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellProcessRead,
  type ShellRunResult,
} from "@deepseek-ai/dsh-shell";
import z from "@deepseek-ai/schemastery";
import { metrics } from "@opentelemetry/api";

import type { RunnerClient } from "./runner-client.js";
import { pathInSandbox } from "./sandbox-path.js";

const execDuration = metrics
  .getMeter("dsh-sandbox-provider")
  .createHistogram("dsh.sandbox.exec.duration", { unit: "ms" });

export interface Config {
  cwd?: string;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  outputMaxBytes?: number;
}

interface ResolvedConfig {
  cwd: string;
  timeoutMs: number;
  maxTimeoutMs: number;
  outputMaxBytes: number;
}

export class SandboxShellExecutor extends ShellExecutor {
  static inject = ["sandboxManager", "agents"];
  static Config = z.object({
    cwd: z.string(),
    timeoutMs: z.number().min(1).default(300_000),
    maxTimeoutMs: z.number().min(1).default(3_600_000),
    outputMaxBytes: z
      .natural()
      .min(1)
      .default(1024 * 1024),
  });
  private readonly config: ResolvedConfig;
  private readonly live = new Set<RemoteShellProcess>();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.config = {
      cwd: config.cwd ?? ctx.sandboxManager.workspace,
      timeoutMs: config.timeoutMs ?? 300_000,
      maxTimeoutMs: config.maxTimeoutMs ?? 3_600_000,
      outputMaxBytes: config.outputMaxBytes ?? 1024 * 1024,
    };
    ctx.effect(() => async () => {
      for (const process of this.live) process.kill();
      await Promise.all([...this.live].map((process) => process.done));
    });
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = Math.min(
      request.timeoutMs ?? this.config.timeoutMs,
      this.config.maxTimeoutMs,
    );
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("shell timeout must be positive");
    const sessionWorkspace =
      this.ctx.agents.requireInitiator().session.header.cwd;
    return {
      command: request.command,
      workdir: pathInSandbox(
        request.workdir ?? this.config.cwd,
        sessionWorkspace,
        this.config.cwd,
      ),
      timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes ?? this.config.outputMaxBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
      sandboxPolicy: request.sandboxPolicy,
    };
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const client = await this.ctx.sandboxManager.clientForCurrentAgent();
    const timeout = new AbortController();
    const combined = combineSignals(spec.signal, timeout.signal);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort(new Error("shell timeout"));
    }, spec.timeoutMs);
    timer.unref();
    const stdout = new TailBuffer(spec.stdoutMaxBytes);
    const stderr = new TailBuffer(this.config.outputMaxBytes);
    const started = Date.now();
    try {
      const outcome = await runShell(client, spec, combined, stdout, stderr);
      return {
        ...outcome,
        timedOut,
        aborted: !timedOut && spec.signal?.aborted === true,
        timeoutMs: spec.timeoutMs,
        stdout: stdout.collected(),
        stderr: stderr.collected(),
      };
    } catch (error) {
      if (!combined.aborted) throw error;
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut,
        aborted: !timedOut,
        timeoutMs: spec.timeoutMs,
        stdout: stdout.collected(),
        stderr: stderr.collected(),
      };
    } finally {
      clearTimeout(timer);
      execDuration.record(Date.now() - started, { kind: "shell" });
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    const controller = new AbortController();
    const process = new RemoteShellProcess(
      controller,
      spec.stdoutMaxBytes,
      this.config.outputMaxBytes,
    );
    this.live.add(process);
    void process.done.finally(() => this.live.delete(process));
    void this.ctx.sandboxManager
      .clientForCurrentAgent()
      .then((client) =>
        runShell(
          client,
          spec,
          combineSignals(spec.signal, controller.signal),
          process.stdout,
          process.stderr,
        ),
      )
      .then((outcome) => process.complete(outcome))
      .catch((error: unknown) => process.fail(error));
    return process;
  }
}

async function runShell(
  client: RunnerClient,
  spec: ShellExecSpec,
  signal: AbortSignal,
  stdout: TailBuffer,
  stderr: TailBuffer,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  const stream = client.exec(
    {
      argv: ["/bin/bash", "-lc", spec.command],
      cwd: spec.workdir,
      env: { ...spec.env, ...spec.dshEnv },
      stdin: new TextEncoder().encode(spec.stdin ?? ""),
    },
    { signal },
  );
  let outcome:
    | { exitCode: number | null; signal: NodeJS.Signals | null }
    | undefined;
  for await (const response of stream) {
    if (response.event.case === "stdout") stdout.append(response.event.value);
    else if (response.event.case === "stderr")
      stderr.append(response.event.value);
    else if (response.event.case === "exited") {
      outcome = {
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
  if (outcome === undefined)
    throw new Error("runner exec stream ended without an exit status");
  return outcome;
}

class TailBuffer {
  private text = "";
  private bytes = 0;
  private dropped = false;
  private readonly decoder = new TextDecoder();

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    const next = this.decoder.decode(chunk, { stream: true });
    this.text += next;
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes) {
      this.dropped = true;
      const encoded = new TextEncoder().encode(this.text);
      const tail = encoded.subarray(
        Math.max(0, encoded.byteLength - this.maxBytes),
      );
      this.text = new TextDecoder().decode(tail);
      this.bytes = tail.byteLength;
    }
  }

  collected(): CollectedOutput {
    return { text: this.text, truncated: this.dropped };
  }

  readAndClear(): { text: string; lossy: boolean } {
    const value = { text: this.text, lossy: this.dropped };
    this.text = "";
    this.bytes = 0;
    this.dropped = false;
    return value;
  }
}

class RemoteShellProcess implements ShellProcess {
  status: "running" | "completed" | "killed" = "running";
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  readonly stdout: TailBuffer;
  readonly stderr: TailBuffer;
  readonly done: Promise<void>;
  private finish!: () => void;

  constructor(
    private readonly controller: AbortController,
    stdoutMaxBytes: number,
    stderrMaxBytes: number,
  ) {
    this.stdout = new TailBuffer(stdoutMaxBytes);
    this.stderr = new TailBuffer(stderrMaxBytes);
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  complete(outcome: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }): void {
    this.exitCode = outcome.exitCode;
    this.signal = outcome.signal;
    this.status = outcome.signal === null ? "completed" : "killed";
    this.finish();
  }

  fail(error: unknown): void {
    this.stderr.append(new TextEncoder().encode(`${String(error)}\n`));
    this.status = "killed";
    this.signal = "SIGTERM";
    this.finish();
  }

  readOutput(): ShellProcessRead {
    const stdout = this.stdout.readAndClear();
    const stderr = this.stderr.readAndClear();
    return {
      delta: `${stdout.text}${stderr.text.length === 0 ? "" : `\n[stderr]\n${stderr.text}`}`,
      lossy: stdout.lossy || stderr.lossy,
    };
  }

  kill(): boolean {
    if (this.status !== "running") return false;
    this.controller.abort(new Error("background process killed"));
    return true;
  }
}

function combineSignals(
  first?: AbortSignal,
  second?: AbortSignal,
): AbortSignal {
  const signals = [first, second].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  return signals.length === 0
    ? new AbortController().signal
    : AbortSignal.any(signals);
}

export const testing = { TailBuffer };
export default SandboxShellExecutor;
