import { createHash, randomBytes } from "node:crypto";

import { SandboxNotFoundError } from "../types.js";
import type {
  BackendReference,
  SandboxBackend,
  SandboxHandle,
  SandboxSpec,
} from "../types.js";

const API_URL = "https://api.buildkite.com/v2";
const SESSION_METADATA_KEY = "dsh-session";

/** Build states after which no job of the build will run again. */
const FINISHED_STATES = new Set([
  "passed",
  "failed",
  "canceled",
  "canceling",
  "skipped",
  "not_run",
  "waiting_failed",
]);

interface BuildkiteReference extends BackendReference {
  buildNumber: number;
  sandboxId: string;
}

interface Build {
  number: number;
  state: string;
  web_url: string;
  env?: Record<string, string>;
}

export interface BuildkiteBackendOptions {
  organization: string;
  pipeline: string;
  /** Runner image, handed to the job so it matches the host's release. */
  image: string;
  /** Branch the build is recorded against; the pipeline's steps must not depend on it. */
  branch: string;
  /** The tunnel endpoint runners dial, such as tls://dsh.example.com:8081. */
  hostUrl: string;
  /** How long a build may sit in the queue before its job starts. */
  readyTimeoutMs: number;
  /** API token with read_builds and write_builds on the pipeline. */
  token: string;
}

/**
 * One sandbox is one Buildkite build. The provider tells the job which
 * sandbox it is, where to dial, and which runner image to run; the pipeline
 * supplies the registration token, so the job needs nothing else from the host.
 */
export class BuildkiteBackend implements SandboxBackend {
  readonly name = "buildkite";
  readonly capabilities = { supportsHibernate: false };

  constructor(
    private readonly options: BuildkiteBackendOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async provision(spec: SandboxSpec): Promise<SandboxHandle> {
    // The provider may have stopped after creating the build but before
    // saving its record. The session tag on the build makes that recoverable.
    let build = await this.findLiveBuild(spec.sessionId);
    let sandboxId = build?.env?.SANDBOX_ID;
    if (build === undefined || sandboxId === undefined) {
      sandboxId = sandboxName(spec.sessionId);
      build = await this.request<Build>("POST", "/builds", {
        commit: "HEAD",
        branch: this.options.branch,
        message: `dsh sandbox ${sandboxId}`,
        env: {
          SANDBOX_ID: sandboxId,
          HOST_URL: this.options.hostUrl,
          DSH_RUNNER_IMAGE: this.options.image,
        },
        meta_data: { [SESSION_METADATA_KEY]: spec.sessionId },
      });
    }
    await this.waitForRunning(build);
    return { sandboxId, reference: { buildNumber: build.number, sandboxId } };
  }

  async hibernate(): Promise<void> {
    throw new Error("a Buildkite build cannot be suspended");
  }

  /**
   * A build never sleeps, so wake only answers the manager's recovery probe:
   * a build that is still queued or running is handed back, a finished one
   * is reported missing so the manager provisions a replacement.
   */
  async wake(reference: BackendReference): Promise<SandboxHandle> {
    const ref = buildkiteReference(reference);
    const build = await this.getBuild(ref.buildNumber);
    if (build === undefined) {
      throw new SandboxNotFoundError(
        `Buildkite build ${ref.buildNumber} no longer exists`,
      );
    }
    if (FINISHED_STATES.has(build.state)) {
      throw new SandboxNotFoundError(
        `Buildkite build ${build.web_url} has ${build.state}`,
      );
    }
    await this.waitForRunning(build);
    return { sandboxId: ref.sandboxId, reference: ref };
  }

  async destroy(reference: BackendReference): Promise<void> {
    await this.cancel(buildkiteReference(reference).buildNumber);
  }

  async expireAt(): Promise<void> {
    throw new Error("a Buildkite build cannot be suspended");
  }

  async health(reference: BackendReference): Promise<boolean> {
    const ref = buildkiteReference(reference);
    const build = await this.getBuild(ref.buildNumber);
    return build?.state === "running";
  }

  private async cancel(number: number): Promise<void> {
    try {
      await this.request("PUT", `/builds/${number}/cancel`);
    } catch (error) {
      // 422 is Buildkite's answer for a build that already finished.
      if (!isStatus(error, 404) && !isStatus(error, 422)) {
        throw error;
      }
    }
  }

  private async findLiveBuild(sessionId: string): Promise<Build | undefined> {
    const query = new URLSearchParams({
      [`meta_data[${SESSION_METADATA_KEY}]`]: sessionId,
      exclude_pipeline: "true",
      exclude_jobs: "true",
    });
    query.append("state[]", "scheduled");
    query.append("state[]", "running");
    const builds = await this.request<Build[]>("GET", `/builds?${query}`);
    return builds[0];
  }

  private async getBuild(number: number): Promise<Build | undefined> {
    try {
      return await this.request<Build>(
        "GET",
        `/builds/${number}?exclude_jobs=true&exclude_pipeline=true`,
      );
    } catch (error) {
      if (isStatus(error, 404)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * A build is `scheduled` until an agent starts its first job. Waiting here
   * covers queue time and image pull, so the manager's shorter wait for the
   * runner's tunnel only has to cover the runner process starting.
   */
  private async waitForRunning(initial: Build): Promise<void> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    let build = initial;
    while (build.state !== "running") {
      if (FINISHED_STATES.has(build.state)) {
        throw new Error(
          `Buildkite build ${build.web_url} ${build.state} before its runner started`,
        );
      }
      if (Date.now() >= deadline) {
        // Cancel so a job that starts later does not dial in as a sandbox
        // nobody is waiting for.
        await this.cancel(build.number).catch(() => {});
        throw new Error(
          `Buildkite build ${build.web_url} did not start within ${this.options.readyTimeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const current = await this.getBuild(build.number);
      if (current === undefined) {
        throw new Error(`Buildkite build ${build.web_url} disappeared`);
      }
      build = current;
    }
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${API_URL}/organizations/${encodeURIComponent(this.options.organization)}/pipelines/${encodeURIComponent(this.options.pipeline)}${path}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new BuildkiteApiError(
        method,
        url,
        response.status,
        await response.text().catch(() => ""),
      );
    }
    return (await response.json()) as T;
  }
}

class BuildkiteApiError extends Error {
  constructor(
    method: string,
    url: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Buildkite ${method} ${url} failed with ${status}: ${detail}`);
    this.name = "BuildkiteApiError";
  }
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof BuildkiteApiError && error.status === status;
}

function buildkiteReference(value: BackendReference): BuildkiteReference {
  if (
    typeof value.buildNumber !== "number" ||
    typeof value.sandboxId !== "string"
  ) {
    throw new Error("invalid Buildkite sandbox reference");
  }
  return value as BuildkiteReference;
}

/**
 * Every provision is a new build, and a cancelled job's runner may still be
 * redialing for a few seconds, so each build gets an id of its own instead
 * of the session's stable hash alone.
 */
function sandboxName(sessionId: string): string {
  const hash = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return `dsh-${hash}-${randomBytes(3).toString("hex")}`;
}

export const testing = { buildkiteReference, sandboxName };
