import type { Checkpoint } from "./checkpoint.js";

export type BackendReference = Record<string, unknown>;

export type BackendName = "docker" | "kas" | "buildkite";

/**
 * One operator-defined way to run a sandbox: a backend and everything that
 * backend needs, fully resolved. A profile is self-contained, so two profiles
 * on the same backend may point at different clusters or Docker hosts.
 */
export type SandboxProfile = DockerProfile | KasProfile | BuildkiteProfile;

export interface DockerProfile {
  name: string;
  backend: "docker";
  /** Runner image; its size limits are whatever Docker gives a container. */
  image: string;
  binary?: string;
  /** The tunnel endpoint runners dial, such as ws://host.docker.internal:8081/tunnel. */
  hostUrl: string;
}

export interface KasProfile {
  name: string;
  backend: "kas";
  namespace: string;
  /** Warm pool to claim from; its template fixes the pod resources. */
  warmPool: string;
  readyTimeoutMs: number;
  kubeconfig?: string;
}

export interface BuildkiteProfile {
  name: string;
  backend: "buildkite";
  organization: string;
  /** Pipeline whose single job runs the runner; one build is one sandbox. */
  pipeline: string;
  /** Runner image the job should run; passed to the build as DSH_RUNNER_IMAGE. */
  image: string;
  /** The tunnel endpoint runners dial; Buildkite agents are never local. */
  hostUrl: string;
  readyTimeoutMs: number;
  /** Host environment variable holding the API token. */
  tokenEnv: string;
}

export interface SandboxSpec {
  sessionId: string;
  repositoryUrl: string;
}

export interface SandboxHandle {
  sandboxId: string;
  reference: BackendReference;
}

export interface BackendCapabilities {
  supportsHibernate: boolean;
  /**
   * Declared only by a backend that hibernates: whether waking returns the
   * machine that stopped (Docker starts the container it stopped) or builds a
   * new one around the surviving workspace (Kubernetes recreates the pod). A
   * backend that cannot hibernate never wakes from one, so it leaves this out.
   * A hibernating backend that leaves it out is read as `false`, the
   * cautious answer.
   */
  wakeKeepsFilesystem?: boolean;
}

export class SandboxNotFoundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxNotFoundError";
  }
}

/**
 * A backend owns sandbox acquisition and lifecycle, not transport: runners
 * dial the host tunnel themselves, so there is no connect() here.
 */
export interface SandboxBackend {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  provision(spec: SandboxSpec): Promise<SandboxHandle>;
  hibernate(reference: BackendReference): Promise<void>;
  wake(reference: BackendReference): Promise<SandboxHandle>;
  destroy(reference: BackendReference): Promise<void>;
  expireAt(reference: BackendReference, deadline: Date): Promise<void>;
  health(reference: BackendReference): Promise<boolean>;
}

interface SessionRecordBase {
  sessionId: string;
  backend: string;
  /** Profile the sandbox was provisioned with. */
  profile: string;
  repositoryUrl: string;
  updatedAt: string;
}

/** A live sandbox. */
export interface RunningRecord extends SessionRecordBase {
  state: "running";
  sandboxId: string;
  reference: BackendReference;
}

/** A suspended sandbox that the backend keeps until `expiresAt`. */
export interface HibernatedRecord extends SessionRecordBase {
  state: "hibernated";
  sandboxId: string;
  reference: BackendReference;
  expiresAt: string;
}

/**
 * No sandbox exists: the backend could not hibernate, so the work was saved
 * as a git bundle on the host and the sandbox destroyed. The next turn
 * provisions a fresh one and restores it, until `expiresAt`.
 */
export interface CheckpointedRecord extends SessionRecordBase {
  state: "checkpointed";
  checkpoint: Checkpoint;
  expiresAt: string;
}

export type SessionRecord =
  | RunningRecord
  | HibernatedRecord
  | CheckpointedRecord;
