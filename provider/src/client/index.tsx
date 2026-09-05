import type { Context } from "@deepseek-ai/cordis";
// These two type-only imports load the declaration merges that put `remote`
// and `slots` on the browser Context.
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";

import { workbenchRemote } from "../remote-contributions.js";
import { InstructionsSettings } from "./instructions.js";
import { SandboxProfileChip } from "./profile.js";
import { RepositoryDirectoryFlow } from "./repository-directory-flow.js";
import { SecretsFooterAction } from "./secrets.js";

/**
 * The client bundle entry: mounts the Remote endpoints and registers the
 * bundle's UI contributions into the dsh Web slots. The contributed views
 * themselves live next to this file, one module per feature.
 */
export const inject = ["remote", "slots"];

/** Mount the Remote endpoints, replace folder picking with repository entry,
 * and add the Secrets manager beside Settings at the sidebar foot. */
export async function apply(ctx: Context) {
  const disposeRemote = await ctx.remote.$mount(workbenchRemote);

  ctx.inject(["remote.sandboxManager"], (remoteCtx) => {
    const unwrap = <T,>(result: RemoteResult<T>): T => {
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    };
    const injected = () => ({
      listSecrets: async () =>
        unwrap(await remoteCtx.remote.sandboxManager.listSecrets()),
      setSecret: async (name: string, value: string) =>
        unwrap(await remoteCtx.remote.sandboxManager.setSecret(name, value)),
      deleteSecret: async (name: string) =>
        unwrap(await remoteCtx.remote.sandboxManager.deleteSecret(name)),
    });
    const injectedInstructions = () => ({
      getInstructions: async () =>
        unwrap(await remoteCtx.remote.sandboxManager.getInstructions()),
      setGlobalInstructions: async (content: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setGlobalInstructions(content),
        ),
      setWorkspaceInstructions: async (
        repositoryUrl: string,
        content: string,
      ) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setWorkspaceInstructions(
            repositoryUrl,
            content,
          ),
        ),
    });
    remoteCtx.slots.inject(
      "sidebar.footer.action",
      function* registerSecrets() {
        yield remoteCtx.slots.register(
          // A list slot requires a stable per-entry id.
          {
            name: "sidebar.footer.action",
            id: "dsh-workbench.secrets",
            inject: injected,
          },
          SecretsFooterAction,
        );
      },
    );
    remoteCtx.slots.inject(
      "settings.section",
      function* registerInstructions() {
        yield remoteCtx.slots.register(
          {
            name: "settings.section",
            id: "dsh-workbench.instructions",
            order: 30,
            label: "Instructions",
            inject: injectedInstructions,
          },
          InstructionsSettings,
        );
      },
    );
    const injectedProfile = () => ({
      getSessionProfile: async (sessionId: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.getSessionProfile(sessionId),
        ),
      setSessionProfile: async (sessionId: string, profile: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.setSessionProfile(
            sessionId,
            profile,
          ),
        ),
    });
    remoteCtx.slots.inject(
      "conversation.input.left",
      function* registerProfileChip() {
        yield remoteCtx.slots.register(
          {
            name: "conversation.input.left",
            id: "dsh-workbench.profile",
            inject: injectedProfile,
          },
          SandboxProfileChip,
        );
      },
    );
  });

  ctx.inject(["remote.sandboxManager"], (remoteCtx) => {
    const createWorkspaceAnchor = async (repositoryUrl: string) => {
      const result =
        await remoteCtx.remote.sandboxManager.createRepositoryWorkspace(
          repositoryUrl,
        );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    };
    const injected = () => ({ createWorkspaceAnchor });

    remoteCtx.slots.inject("conversation.hero.workspace.directoryFlow", () =>
      remoteCtx.slots.inject(
        "sidebar.workspaces.directoryFlow",
        function* registerRepositoryFlows() {
          yield remoteCtx.slots.register(
            {
              name: "conversation.hero.workspace.directoryFlow",
              inject: injected,
            },
            RepositoryDirectoryFlow,
          );
          yield remoteCtx.slots.register(
            {
              name: "sidebar.workspaces.directoryFlow",
              inject: injected,
            },
            RepositoryDirectoryFlow,
          );
        },
      ),
    );
  });

  return () => {
    void disposeRemote();
  };
}

export {
  RepositoryDirectoryFlow,
  type RepositoryDirectoryFlowProps,
} from "./repository-directory-flow.js";
