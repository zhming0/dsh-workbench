/**
 * Sandbox truth for the model-facing system prompt.
 *
 * dsh composes statements into every session's system prompt that only hold
 * on the dsh host. It names the session working directory in host
 * coordinates — for this provider, a bookkeeping anchor that does not exist
 * inside the sandbox — points at the host's dsh implementation checkout, and
 * describes the Web GUI as if the model could reach it. Sandboxed sessions
 * work entirely in sandbox paths, so this module:
 *
 * 1. shadows the `cwd` prompt variable with the sandbox workspace, so the
 *    "Your working directory is …" line names a path the model's tools
 *    actually resolve;
 * 2. contributes a short environment section stating where tools run; and
 * 3. drops the host-only checkout and GUI sections from the assembled prompt,
 *    matching their text rather than a section name or position, so the
 *    removal survives dsh refactors of its prompt composition. If a dsh
 *    update rewords those statements, the match stops and the section ships
 *    unchanged — a visible failure, because the listener logs a warning when
 *    nothing matches, and item 2 still states the facts.
 *
 * @module @zhming0/dsh-workbench/sandbox-context
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

/** Name of the environment section this module contributes. */
export const SANDBOX_ENVIRONMENT_SECTION = "environment:sandbox";

/**
 * The environment section text. `{{cwd}}` renders the sandbox workspace
 * through the shadowed prompt variable. The last sentence carries the
 * "this page means the GUI" mapping from the Web GUI paragraph dsh composes:
 * that mapping stays true for a sandboxed session even though the URL does
 * not, so dropping the paragraph must not lose it.
 */
export const SANDBOX_ENVIRONMENT_PROMPT =
  'You are working inside an isolated sandbox: file and shell tools resolve paths inside this sandbox, and the repository checkout is mounted at {{cwd}}. There is no DeepSeek Harness source checkout inside the sandbox; the DeepSeek Harness web UI runs on the host machine and is unreachable from here. When the user says "this page", "this GUI", or "this app", they mean that web UI.';

/**
 * Fragments that identify dsh's host-only prompt sections (observed in
 * 0.1.5-rc.2): the implementation-checkout paragraph and the Web GUI
 * paragraph. Deliberately narrow, so only sections making those claims are
 * dropped.
 */
const HOST_ONLY_SECTION_MARKERS = [
  "implementation checkout is at",
  "Web GUI at",
] as const;

/** @returns whether a section's text claims a host-only fact. */
export function isHostOnlySection(text: string): boolean {
  return HOST_ONLY_SECTION_MARKERS.some((marker) => text.includes(marker));
}

interface AssembledSectionLike {
  name: string;
  text: string;
}

/**
 * Drop host-only sections from an assembly's section list, in place.
 * @returns how many sections were dropped.
 */
export function dropHostOnlySections(sections: AssembledSectionLike[]): number {
  const kept = sections.filter((section) => !isHostOnlySection(section.text));
  const dropped = sections.length - kept.length;
  if (dropped > 0) {
    sections.splice(0, sections.length, ...kept);
  }
  return dropped;
}

/** The systemPrompt surface this module needs, structural for testing. */
interface SystemPromptLike {
  getSectionOrder(name: string): number;
  section(section: { name: string; order: number; text: string }): unknown;
  variable(
    name: string,
    provider: (context: unknown) => string | undefined,
  ): unknown;
}

/**
 * Register the environment section and the sandbox `cwd` variable on one
 * agent's system prompt scope, shadowing the loop-supplied host cwd.
 */
export function installSandboxContext(
  systemPrompt: SystemPromptLike,
  workspace: () => string,
): void {
  systemPrompt.section({
    name: SANDBOX_ENVIRONMENT_SECTION,
    order: systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
    text: SANDBOX_ENVIRONMENT_PROMPT,
  });
  systemPrompt.variable("cwd", () => workspace());
}

export const name = "sandbox-context";
export const inject = ["sandboxManager", "agents"];

export function apply(ctx: Context): void {
  // In this distribution dsh composes the host-only sections into every
  // assembly, so zero matches means dsh reworded or removed them and the
  // markers need revisiting. Once per process is enough to surface that.
  let warnedNoMatch = false;
  ctx.on("system-prompt/assemble", (assembly, _context, next) => {
    if (dropHostOnlySections(assembly.sections) === 0 && !warnedNoMatch) {
      warnedNoMatch = true;
      ctx.logger.warn(
        "sandbox-context: no host-only prompt sections matched; if a dsh update reworded or removed its checkout or Web GUI paragraphs, revisit the markers in sandbox-context.ts",
      );
    }
    return next();
  });

  const promptFibers = new Map<Agent, ReturnType<Context["inject"]>>();
  const promptDisposals = new Set<Promise<void>>();
  const installPrompt = (agent: Agent): void => {
    if (promptFibers.has(agent)) {
      return;
    }
    const fiber = agent.ctx.inject(["systemPrompt"], (scope) => {
      installSandboxContext(
        scope.systemPrompt,
        () => ctx.sandboxManager.workspace,
      );
    });
    promptFibers.set(agent, fiber);
  };
  const disposePrompt = (agent: Agent): void => {
    const fiber = promptFibers.get(agent);
    if (fiber === undefined) {
      return;
    }
    promptFibers.delete(agent);
    const task = fiber.dispose().catch((error: unknown) => {
      ctx.logger.warn(
        `sandbox-context: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    promptDisposals.add(task);
    void task.finally(() => {
      promptDisposals.delete(task);
    });
  };
  for (const agent of ctx.agents.list()) {
    installPrompt(agent);
  }
  ctx.on("agent/created", ({ agent }) => {
    installPrompt(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    disposePrompt(agent);
  });
  ctx.effect(
    () => async () => {
      const fibers = [...promptFibers.values()];
      promptFibers.clear();
      await Promise.all([
        ...fibers.map((fiber) => fiber.dispose()),
        ...promptDisposals,
      ]);
    },
    "sandbox-context: disposal",
  );
}
