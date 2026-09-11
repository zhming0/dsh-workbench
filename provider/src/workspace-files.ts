/**
 * Runs dsh's Web file browser (`workspaceFiles`) as the session it serves.
 *
 * `@deepseek-ai/dsh-api-workspace-files` serves the Files and Preview sidebar
 * tabs and the deliverables cards: it lists directories and reads files
 * through `ctx.fs`, rooted at the session cwd. Those calls arrive from the
 * browser, outside any agent turn. This package's filesystem finds a session's
 * sandbox through the agent that is asking (`ctx.agents.requireInitiator()`),
 * so the stock service run as-is fails with "no initiator" on every request.
 *
 * The wire already names the session: every method takes a
 * `workspaceFileScope` that the gateway resolves from the request's session
 * id. This module keeps the stock row mounted and wraps its methods on the
 * live service so each one runs as that session's agent. The agent comes from
 * `sessionController.resolveAgent`, which returns the live agent or resumes a
 * stored session. A request then reaches the sandbox the way a tool call
 * does: a hibernated sandbox wakes, and the read counts as activity for the
 * idle timer. docs/plans/web-sidebar.md records the never-wake design that
 * would change that, should browsing turn out to keep sandboxes up.
 *
 * The stock row has to stay mounted, and under its own name, because its
 * browser half comes with it: the Web app serves a package's client bundle
 * only for a mounted row of that package, and the sidebar's file resource
 * provider lives in that bundle. Replacing the row with a subclass would leave
 * the sidebar without it. The wrappers are own properties on the service
 * instance, so the stock prototype methods and their remote markers, which
 * the gateway reads, are untouched; disposing the row removes them.
 *
 * Path translation needs no changes here: the scope's `workspaceRoot` is the
 * session cwd on the host, and `SandboxFileSystem.resolve` already maps the
 * session cwd onto the sandbox workspace for the agent it runs as. Every path
 * the browser gets back is a sandbox path.
 *
 * @module @zhming0/dsh-workbench/workspace-files
 */

import { symbols, type Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {
  WorkspaceFileScope,
  WorkspaceFileWatchFrame,
  WorkspaceFiles,
} from "@deepseek-ai/dsh-api-workspace-files";

/** The stock request methods. Each takes the session scope first. */
const REQUEST_METHODS = [
  "read",
  "readBytes",
  "readAll",
  "readRelated",
  "stat",
  "list",
] as const;

type RequestMethod = (typeof REQUEST_METHODS)[number];

type ScopedRequest = (
  this: WorkspaceFiles,
  workspaceFileScope: WorkspaceFileScope,
  ...rest: unknown[]
) => Promise<unknown>;

type ScopedChanges = (
  this: WorkspaceFiles,
  workspaceFileScope: WorkspaceFileScope,
  signal: AbortSignal,
) => AsyncIterable<WorkspaceFileWatchFrame>;

type SessionAgents = Pick<Context["agents"], "withInitiator">;
type SessionResolver = Pick<Context["sessionController"], "resolveAgent">;

/**
 * Wrap the live `workspaceFiles` service so every method runs as the agent of
 * the session named in its scope. Returns the undo.
 * @param files - the service instance, with any cordis proxy removed.
 */
export function scopeToSession(
  files: WorkspaceFiles,
  agents: SessionAgents,
  sessionController: SessionResolver,
): () => void {
  /**
   * The session's live agent, resuming the session when it is only stored.
   * `resolveAgent` reports failures as values; they become thrown
   * `RemoteError`s here so the gateway answers the browser with the stable
   * session-domain code (`session/not-found`, `session/agent-busy`).
   */
  const agentFor = async (scope: WorkspaceFileScope): Promise<Agent> => {
    const resolved = await sessionController.resolveAgent(scope.sessionId);
    if ("error" in resolved) {
      throw resolved.error;
    }
    return resolved.agent;
  };

  const undo: (() => void)[] = [];
  const replace = (method: RequestMethod | "changes", value: unknown): void => {
    Object.defineProperty(files, method, {
      configurable: true,
      writable: true,
      value,
    });
    undo.push(() => {
      Reflect.deleteProperty(files, method);
    });
  };

  for (const method of REQUEST_METHODS) {
    const stock = Reflect.get(files, method) as ScopedRequest;
    const scoped: ScopedRequest = async function (workspaceFileScope, ...rest) {
      const agent = await agentFor(workspaceFileScope);
      return agents.withInitiator(agent, () =>
        stock.call(this, workspaceFileScope, ...rest),
      );
    };
    replace(method, scoped);
  }

  // The stock feed resolves the workspace root through `ctx.fs` when it is
  // first pulled, and the pull that produces each frame runs its `contains`
  // and `processPath` checks. An async generator's body resumes in the
  // context of whoever pulls it, so every step runs as the session's agent.
  const stockChanges = Reflect.get(files, "changes") as ScopedChanges;
  const scopedChanges: ScopedChanges = async function* (
    workspaceFileScope,
    signal,
  ) {
    const agent = await agentFor(workspaceFileScope);
    const frames = stockChanges.call(this, workspaceFileScope, signal);
    const inner = frames[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await agents.withInitiator(agent, () => inner.next());
        if (step.done) {
          return;
        }
        yield step.value;
      }
    } finally {
      await inner.return?.();
    }
  };
  replace("changes", scopedChanges);

  return () => {
    for (const restore of undo) {
      restore();
    }
  };
}

export const name = "sandbox-workspace-files";

/**
 * Wait for the service instead of injecting it: `workspaceFiles` and
 * `sessionController` come with the Web surface only, and dsh refuses to boot
 * over a row whose services never arrive, so waiting inside the row keeps a
 * headless profile bootable.
 */
export function apply(ctx: Context): void {
  ctx.inject(["workspaceFiles", "agents", "sessionController"], (scope) => {
    // `scope.workspaceFiles` is a cordis proxy that rebinds `this.ctx` per
    // caller; define the wrappers on the instance behind it.
    const files = Reflect.get(scope.workspaceFiles, symbols.original) as
      | WorkspaceFiles
      | undefined;
    scope.effect(() =>
      scopeToSession(
        files ?? scope.workspaceFiles,
        scope.agents,
        scope.sessionController,
      ),
    );
  });
}
