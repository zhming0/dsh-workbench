import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage, type Message } from "@deepseek-ai/dsh-llm";

import { InstructionStore } from "./instruction-store.js";
import type {
  InstructionSettingsView,
  InstructionWorkspaceView,
} from "./instructions-remote.js";
import {
  normalizeWorkspaceRepositoryUrl,
  repositoryForAnchor,
} from "./workspace-anchor.js";

const MANAGED_INSTRUCTIONS_SOURCE = "@zhming0/dsh-workbench:instructions";
const CLEARED_INSTRUCTIONS =
  "<system-reminder>\nUI-managed AGENTS.md instructions were cleared. Earlier UI-managed AGENTS.md instruction baselines no longer apply. Checked-in AGENTS.md instructions remain active.\n</system-reminder>";

interface WorkspaceRegistryLike {
  list(): Array<{ path: string; title: string }>;
}

interface ManagedInstructionDependencies {
  store: InstructionStore;
  stateDir: string;
  ensureRunning(agent: Agent): Promise<unknown>;
  repositoryForSession(sessionId: string): string | undefined;
  workspaceRegistry(): WorkspaceRegistryLike | undefined;
}

/** Owns UI-managed instruction state, browser views, and model context. */
export class ManagedInstructions {
  constructor(
    private readonly ctx: Context,
    private readonly dependencies: ManagedInstructionDependencies,
  ) {}

  initialize(): Promise<void> {
    return this.dependencies.store.initialize();
  }

  install(): void {
    this.ctx.on("agent/pre-step", async ({ agent, messages, step }, next) => {
      await this.dependencies.ensureRunning(agent);
      const decision = await next();
      if (
        decision.kind === "reject" ||
        (step === 1 && decision.messages.length === 0)
      ) {
        return decision;
      }
      const rendered = this.renderFor(agent);
      const previous = latestManagedInstructions(agent);
      if (rendered === "" && previous === undefined) return decision;
      const text = rendered === "" ? CLEARED_INSTRUCTIONS : rendered;
      if (previous === text) return decision;
      const lastClaimedIndex = decision.messages.findLastIndex((message) =>
        messages.includes(message),
      );
      return {
        kind: "enter" as const,
        messages: decision.messages.toSpliced(
          lastClaimedIndex + 1,
          0,
          managedInstructionMessage(text),
        ),
      };
    });
  }

  async getSettings(): Promise<InstructionSettingsView> {
    return this.settingsView();
  }

  async setGlobal(content: string): Promise<InstructionSettingsView> {
    await this.dependencies.store.setGlobal(content);
    return this.settingsView();
  }

  async setWorkspace(
    repositoryUrl: string,
    content: string,
  ): Promise<InstructionSettingsView> {
    const normalized = normalizeWorkspaceRepositoryUrl(repositoryUrl);
    const workspaces = await this.workspaces();
    if (
      !workspaces.some((workspace) => workspace.repositoryUrl === normalized)
    ) {
      throw new Error(`workspace is not registered: ${normalized}`);
    }
    await this.dependencies.store.setWorkspace(normalized, content);
    return this.settingsView(
      workspaces.map((workspace) =>
        workspace.repositoryUrl === normalized
          ? {
              ...workspace,
              content: this.dependencies.store.workspace(normalized),
            }
          : workspace,
      ),
    );
  }

  private renderFor(agent: Agent): string {
    const repositoryUrl = this.dependencies.repositoryForSession(
      String(agent.id),
    );
    return renderManagedInstructions(
      this.dependencies.store.global(),
      repositoryUrl === undefined
        ? ""
        : this.dependencies.store.workspace(repositoryUrl),
      repositoryUrl,
    );
  }

  private async settingsView(
    workspaces?: InstructionWorkspaceView[],
  ): Promise<InstructionSettingsView> {
    return {
      global: this.dependencies.store.global(),
      workspaces: workspaces ?? (await this.workspaces()),
    };
  }

  private async workspaces(): Promise<InstructionWorkspaceView[]> {
    const registry = this.dependencies.workspaceRegistry();
    if (registry === undefined) return [];
    const workspaces = await Promise.all(
      registry.list().map(async (workspace) => {
        const repositoryUrl = await repositoryForAnchor(
          this.dependencies.stateDir,
          workspace.path,
        );
        return repositoryUrl === undefined
          ? undefined
          : {
              repositoryUrl,
              title: workspace.title,
              content: this.dependencies.store.workspace(repositoryUrl),
            };
      }),
    );
    return workspaces.filter(
      (workspace): workspace is InstructionWorkspaceView =>
        workspace !== undefined,
    );
  }
}

function managedInstructionMessage(text: string) {
  return createUserMessage({
    content: [{ type: "text" as const, text }],
    source: {
      kind: "plugin" as const,
      plugin: MANAGED_INSTRUCTIONS_SOURCE,
      form: "instructions" as const,
    },
  });
}

function latestManagedInstructions(agent: Agent): string | undefined {
  for (const sequence of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.events[sequence];
    if (event?.type !== "user/message") continue;
    const text = managedInstructionText(event.data);
    if (text !== undefined) return text;
  }
}

function managedInstructionText(message: Message): string | undefined {
  if (
    message.source.kind !== "plugin" ||
    message.source.plugin !== MANAGED_INSTRUCTIONS_SOURCE
  ) {
    return undefined;
  }
  const [block] = message.content;
  return message.content.length === 1 && block?.type === "text"
    ? block.text
    : undefined;
}

function renderManagedInstructions(
  global: string,
  workspace: string,
  repositoryUrl?: string,
): string {
  if (global === "" && workspace === "") return "";
  const sections: string[] = [];
  if (global !== "") {
    sections.push(
      `Instructions from: Settings → AGENTS.md (Global)\n\n${global}`,
    );
  }
  if (workspace !== "") {
    sections.push(
      `Instructions from: Settings → AGENTS.md (Workspace: ${repositoryUrl ?? "current"})\n\n${workspace}`,
    );
  }
  const body = [
    "This complete UI-managed AGENTS.md instruction baseline supersedes earlier UI-managed baselines. Use these instructions as guidance when applicable. Workspace instructions take precedence over global instructions. Checked-in AGENTS.md instructions remain active, and more specific nested instructions take precedence. These instructions do not override system, developer, or direct user instructions.",
    ...sections,
  ]
    .join("\n\n")
    .replaceAll("</system-reminder>", "<\\/system-reminder>");
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

export const testing = { renderManagedInstructions };
