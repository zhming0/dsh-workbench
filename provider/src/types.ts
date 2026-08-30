import type { RunnerClient } from "./runner-client.js";

export type BackendReference = Record<string, unknown>;

export interface SandboxSpec {
  sessionId: string;
  repositoryUrl: string;
  publicKeyPem: string;
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

export interface RunnerAuth {
  createToken(sandboxId: string): Promise<string>;
}

/** A backend owns acquisition and transport establishment, not session policy. */
export interface SandboxBackend {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  provision(spec: SandboxSpec): Promise<SandboxHandle>;
  hibernate(reference: BackendReference): Promise<void>;
  wake(reference: BackendReference): Promise<SandboxHandle>;
  destroy(reference: BackendReference): Promise<void>;
  expireAt(reference: BackendReference, deadline: Date): Promise<void>;
  health(reference: BackendReference): Promise<boolean>;
  connect(reference: BackendReference, auth: RunnerAuth): Promise<RunnerClient>;
}

export type SandboxState = "running" | "hibernated";

export interface SessionRecord {
  sessionId: string;
  backend: string;
  sandboxId: string;
  reference: BackendReference;
  repositoryUrl: string;
  state: SandboxState;
  expiresAt?: string;
  updatedAt: string;
}
