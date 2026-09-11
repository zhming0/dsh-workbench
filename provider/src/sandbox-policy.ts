/**
 * Sandbox stand-in for dsh's `sandboxPolicy` service.
 *
 * The stock `@deepseek-ai/dsh-sandbox-policy` describes the dsh host's own
 * file sandbox: a per-session mode switch, a host directory the agent may
 * write under, and a line in every model request that names that directory.
 * None of that holds here. Every file and shell operation already runs inside
 * the session's sandbox, the host cwd is a bookkeeping anchor the model never
 * sees, and no enabled row enforces or renders a mode.
 *
 * The service still has to exist: the Web file browser (`workspace-files`)
 * and the deliverables host half inject it and read `workspaceRoot`, and dsh
 * refuses to boot while a mounted row waits for a missing service. This
 * module answers those readers with the sandbox workspace and nothing else.
 *
 * @module @zhming0/dsh-workbench/sandbox-policy
 */

import { Context, Service } from "@deepseek-ai/cordis";
import type {
  SandboxExecutionPolicy,
  SandboxMode,
} from "@deepseek-ai/dsh-sandbox";
import type {
  SandboxPolicyRequest,
  SandboxPolicyService,
} from "@deepseek-ai/dsh-sandbox-policy";
import type { Session } from "@deepseek-ai/dsh-session";

/** The stock service's public surface, so the stand-in cannot drift from it. */
type SandboxPolicyContract = Pick<
  SandboxPolicyService,
  "defaultMode" | "workspaceRoot" | "resolve" | "overrideOf"
>;

/**
 * `ctx.sandboxPolicy` for sandbox-backed sessions. Every root it reports is
 * the sandbox workspace path, which is the only directory the agent works in.
 */
export class SandboxPolicy extends Service implements SandboxPolicyContract {
  static inject = ["sandboxManager"];

  /**
   * Nominal: the runner lets the agent write anywhere inside its container,
   * and no enabled row reads this to enforce or describe a boundary.
   */
  readonly defaultMode: SandboxMode = "workspace-write";

  constructor(ctx: Context) {
    super(ctx, "sandboxPolicy");
  }

  /** The sandbox workspace, in sandbox coordinates. */
  get workspaceRoot(): string {
    return this.ctx.sandboxManager.workspace;
  }

  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request;
    return {
      mode: request.mode ?? this.defaultMode,
      workspaceRoot: this.workspaceRoot,
      ...(session === undefined ? {} : { sessionId: session.id }),
    };
  }

  /** Sessions carry no mode override here; there is no switch to record one. */
  overrideOf(_session: Session): SandboxMode | undefined {
    return undefined;
  }
}

export default SandboxPolicy;
