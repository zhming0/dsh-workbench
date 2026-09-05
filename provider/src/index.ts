import { resolveConfig } from "./config.js";
import SandboxManager from "./manager.js";

/**
 * The sandbox provider entry. `SandboxManager` — the bundle row this package
 * inserts — lives in manager.ts; this file only re-exports the package
 * surface. Config types and settings resolution live in config.ts.
 */
export { BuildkiteBackend } from "./backends/buildkite.js";
export { DockerBackend } from "./backends/docker.js";
export { KasBackend } from "./backends/kas.js";
export { CredentialBroker, normalizeRepositoryUrl } from "./broker.js";
export type { Config, ProfileConfig } from "./config.js";
export type { ManagerDependencies } from "./manager.js";
export { SandboxManager };
export default SandboxManager;
export { TunnelServer } from "./tunnel.js";
export type { RunnerGateway } from "./tunnel.js";
export { SandboxNotFoundError } from "./types.js";
export type { SandboxBackend } from "./types.js";

/** Internals the test suite reaches into. */
export const testing = { resolveConfig };
