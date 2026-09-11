import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import type { LifecycleHooks } from "./sandbox-lifecycle.js";

/** One sandbox notice: the model-facing text and its one-line transcript account. */
interface SandboxNotice {
  text: string;
  summary: string;
}

/**
 * The one-turn notes the model sees when ensureRunning brought its session
 * back in an environment it did not last see: a checkpoint restore, a wake
 * that built a new machine, or a wake that reused the old one.
 */
const RESTORE_NOTICE: SandboxNotice = {
  text: "This sandbox was recreated from a checkpoint. Your Git changes and commits are back, but anything not tracked by Git is gone: installed tools, ignored files, and files outside the repository. Previously staged changes are now unstaged. Re-run setup steps you need before continuing.",
  summary: "Sandbox restored from a checkpoint",
};
const WAKE_NOTICE: SandboxNotice = {
  text: "This sandbox was suspended and woke on a newly created machine. Files under /workspace survived, including your home directory, but running processes, /tmp, and anything installed outside /workspace are gone. Re-create what you need before continuing.",
  summary: "Sandbox woke from hibernation",
};
const WAKE_NOTICE_KEPT_FILESYSTEM: SandboxNotice = {
  ...WAKE_NOTICE,
  text: "This sandbox was suspended and woke on the same machine. Its files are intact, but the processes that were running before the suspension are gone. Restart what you need before continuing.",
};
const SANDBOX_NOTICE_SOURCE = "@zhming0/dsh-workbench:sandbox";

export interface SandboxNoticesDependencies {
  /** The root session whose sandbox an agent's work shares. */
  rootSessionId(agent: Agent): string;
}

/**
 * The notices a turn carries when its sandbox came back from somewhere else.
 * The lifecycle hooks queue a note under the root session; the pre-step
 * listener rides it onto the next step's prompt as a user message from this
 * provider. A restore and each kind of wake have their own wording, because
 * what the model finds missing differs.
 */
export class SandboxNotices implements LifecycleHooks {
  private readonly pending = new Map<string, SandboxNotice>();

  constructor(
    private readonly ctx: Context,
    private readonly deps: SandboxNoticesDependencies,
  ) {}

  /**
   * Register the pre-step listener. Install it after the listeners that call
   * ensureRunning, so next() has performed the restore or wake before the
   * notice is read and prepended.
   */
  install(): void {
    this.ctx.on("agent/pre-step", async ({ agent }, next) => {
      const decision = await next();
      if (decision.kind === "reject" || decision.messages.length === 0) {
        return decision;
      }
      const notice = this.take(agent);
      if (notice === undefined) {
        return decision;
      }
      return {
        kind: "enter" as const,
        messages: [noticeMessage(notice), ...decision.messages],
      };
    });
  }

  /** A checkpoint restore completed; the next prompt says what survived. */
  async afterRestore({ sessionId }: { sessionId: string }): Promise<void> {
    this.pending.set(sessionId, RESTORE_NOTICE);
  }

  /** A hibernated sandbox woke; its backend says what the machine kept. */
  async afterWake({
    sessionId,
    keepsFilesystem,
  }: {
    sessionId: string;
    keepsFilesystem: boolean;
  }): Promise<void> {
    this.pending.set(
      sessionId,
      keepsFilesystem ? WAKE_NOTICE_KEPT_FILESYSTEM : WAKE_NOTICE,
    );
  }

  /**
   * The note for this turn's prompt, keyed by root session; reading it
   * consumes it, so the notice rides exactly one step.
   */
  private take(agent: Agent): SandboxNotice | undefined {
    const sessionId = this.deps.rootSessionId(agent);
    const notice = this.pending.get(sessionId);
    if (notice !== undefined) {
      this.pending.delete(sessionId);
    }
    return notice;
  }
}

function noticeMessage(notice: SandboxNotice) {
  return createUserMessage({
    content: [{ type: "text" as const, text: notice.text }],
    source: {
      kind: "plugin" as const,
      plugin: SANDBOX_NOTICE_SOURCE,
      form: "notice" as const,
      summary: notice.summary,
    },
  });
}
