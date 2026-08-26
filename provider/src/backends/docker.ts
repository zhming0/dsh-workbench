import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { connectToRunner, type RunnerClient } from "../runner-client.js";
import { SandboxNotFoundError } from "../types.js";
import type {
  BackendReference,
  RunnerAuth,
  SandboxBackend,
  SandboxHandle,
  SandboxSpec,
} from "../types.js";

const run = promisify(execFile);

interface DockerReference extends BackendReference {
  containerId: string;
  sandboxId: string;
}

export interface DockerBackendOptions {
  image: string;
  binary?: string;
}

export class DockerBackend implements SandboxBackend {
  readonly name = "docker";
  readonly capabilities = { supportsHibernate: true };
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly binary: string;

  constructor(private readonly options: DockerBackendOptions) {
    this.binary = options.binary ?? "docker";
  }

  async provision(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandboxId = sandboxName(spec.sessionId);
    try {
      const { stdout } = await this.command([
        "run",
        "--detach",
        "--name",
        sandboxId,
        "--label",
        `dsh.session=${spec.sessionId}`,
        "--env",
        `SANDBOX_ID=${sandboxId}`,
        "--env",
        `PROVIDER_PUBLIC_KEY=${spec.publicKeyPem}`,
        "--publish",
        "127.0.0.1::8080",
        this.options.image,
      ]);
      return {
        sandboxId,
        reference: { containerId: stdout.trim(), sandboxId },
      };
    } catch (provisionError) {
      // A provider can stop after Docker creates the container but before its
      // session record reaches disk. The stable name and exact session label
      // let the next provider process recover that container safely.
      try {
        const { stdout } = await this.command(["inspect", sandboxId]);
        const existing = parseInspect(stdout);
        if (existing.sessionId !== spec.sessionId) throw provisionError;
        if (existing.status !== "running")
          await this.command(["start", existing.containerId]);
        return {
          sandboxId,
          reference: { containerId: existing.containerId, sandboxId },
        };
      } catch (recoveryError) {
        if (recoveryError === provisionError) throw provisionError;
        throw new Error(`could not create Docker sandbox ${sandboxId}`, {
          cause: provisionError,
        });
      }
    }
  }

  async hibernate(reference: BackendReference): Promise<void> {
    const ref = dockerReference(reference);
    try {
      await this.command(["stop", "--time", "10", ref.containerId]);
    } catch (error) {
      if (isMissingContainer(error)) {
        throw new SandboxNotFoundError(
          `Docker container ${ref.containerId} no longer exists`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async wake(reference: BackendReference): Promise<SandboxHandle> {
    const ref = dockerReference(reference);
    const timer = this.expiryTimers.get(ref.containerId);
    if (timer !== undefined) clearTimeout(timer);
    this.expiryTimers.delete(ref.containerId);
    try {
      await this.command(["start", ref.containerId]);
    } catch (error) {
      if (isMissingContainer(error)) {
        throw new SandboxNotFoundError(
          `Docker container ${ref.containerId} no longer exists`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    return { sandboxId: ref.sandboxId, reference: ref };
  }

  async destroy(reference: BackendReference): Promise<void> {
    const ref = dockerReference(reference);
    const timer = this.expiryTimers.get(ref.containerId);
    if (timer !== undefined) clearTimeout(timer);
    this.expiryTimers.delete(ref.containerId);
    try {
      await this.command(["rm", "--force", "--volumes", ref.containerId]);
    } catch (error) {
      if (!String(error).includes("No such container")) throw error;
    }
  }

  async expireAt(reference: BackendReference, deadline: Date): Promise<void> {
    const ref = dockerReference(reference);
    const prior = this.expiryTimers.get(ref.containerId);
    if (prior !== undefined) clearTimeout(prior);
    const delay = Math.max(0, deadline.getTime() - Date.now());
    const timer = setTimeout(
      () => void this.destroy(ref).catch(() => {}),
      delay,
    );
    timer.unref();
    this.expiryTimers.set(ref.containerId, timer);
  }

  async health(reference: BackendReference): Promise<boolean> {
    const ref = dockerReference(reference);
    try {
      const { stdout } = await this.command([
        "inspect",
        "--format",
        "{{.State.Status}}",
        ref.containerId,
      ]);
      return stdout.trim() === "running";
    } catch (error) {
      if (isMissingContainer(error)) return false;
      throw error;
    }
  }

  async connect(
    reference: BackendReference,
    auth: RunnerAuth,
  ): Promise<RunnerClient> {
    const ref = dockerReference(reference);
    const { stdout } = await this.command([
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}',
      ref.containerId,
    ]);
    const port = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(port))
      throw new Error("Docker did not publish the runner port");
    return connectToRunner(`http://127.0.0.1:${port}`, ref.sandboxId, auth);
  }

  private command(arguments_: string[]) {
    return run(this.binary, arguments_, { maxBuffer: 4 * 1024 * 1024 });
  }
}

function dockerReference(value: BackendReference): DockerReference {
  if (
    typeof value.containerId !== "string" ||
    typeof value.sandboxId !== "string"
  ) {
    throw new Error("invalid Docker sandbox reference");
  }
  return value as DockerReference;
}

function sandboxName(sessionId: string): string {
  const hash = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return `dsh-${hash}`;
}

function isMissingContainer(error: unknown): boolean {
  return error instanceof Error && String(error).includes("No such container");
}

function parseInspect(value: string): {
  containerId: string;
  sessionId: string;
  status: string;
} {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Docker returned an invalid inspect result");
  }
  const container = parsed[0] as {
    Id?: unknown;
    Config?: { Labels?: Record<string, unknown> };
    State?: { Status?: unknown };
  };
  const containerId = container.Id;
  const sessionId = container.Config?.Labels?.["dsh.session"];
  const status = container.State?.Status;
  if (
    typeof containerId !== "string" ||
    typeof sessionId !== "string" ||
    typeof status !== "string"
  ) {
    throw new Error("Docker inspect result is missing sandbox metadata");
  }
  return { containerId, sessionId, status };
}

export const testing = { dockerReference, parseInspect, sandboxName };
