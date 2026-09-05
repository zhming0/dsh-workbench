/**
 * The sandbox manager, composed by role with dependencies flowing one way:
 * the facade (sandbox-manager.ts) and policies (idle.ts, profile-choice.ts)
 * call the lifecycle engine (sandbox-lifecycle.ts), which calls leaf services
 * (runner-attachment.ts, profile-registry.ts, the stores). Features plug into
 * engine-defined seams through LifecycleHooks (file-index-hooks.ts) instead
 * of being called by name. This file only re-exports the public surface.
 */
import SandboxManager from "./sandbox-manager.js";

export { SandboxManager };
export default SandboxManager;
export type { ManagerDependencies } from "./sandbox-manager.js";
