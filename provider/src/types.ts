import type { Checkpoint } from "./checkpoint.js";

export type BackendReference = Record<string, unknown>;

export type BackendName = "docker" | "kas";

/**
 * One operator-defined way to run a sandbox: a backend and everything that
 * backend needs, fully resolved. A profile is self-contained, so two profiles
 * on the same backend may point at different clusters or Docker hosts.
 */
export type SandboxProfile = DockerProfile | KasProfile;

export interface DockerProfile {
  name: string;
  backend: "docker";
  /** Runner image; its size limits are whatever Docker gives a container. */
  image: string;
  binary?: string;
  /** The tunnel endpoint runners dial, such as tcp://host.docker.internal:8081. */
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

export type SandboxState = "running" | "hibernated";

export interface SessionRecord {
  sessionId: string;
  backend: string;
  /** Profile the sandbox was provisioned with. */
  profile: string;
  sandboxId: string;
  reference: BackendReference;
  repositoryUrl: string;
  state: SandboxState;
  expiresAt?: string;
  /**
   * Set on a backend without hibernation from the moment the sandbox is
   * released until a replacement has restored the work: while hibernated, no
   * sandbox exists and the work lives on this remote branch; while running,
   * the restore has not finished yet and will be retried.
   */
  checkpoint?: Checkpoint;
  updatedAt: string;
}
