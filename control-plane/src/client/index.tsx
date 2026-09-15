import type { Context } from "@deepseek-ai/cordis";
// These type-only imports load the declaration merges that put `remote`
// and `slots` on the browser Context, the settings wire types, and the
// `remote.settings` namespace itself.
import type { SettingsPathOpView } from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-api-settings-controller/remote";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import { yawnRemote } from "../remote-contributions.js";
import { InstructionsSettings } from "./instructions.js";
import { SandboxProfileChip } from "./profile.js";
import { RepositoryDirectoryFlow } from "./repository-directory-flow.js";
import { SandboxStatusTab } from "./sandbox.js";
import { SandboxesSettings } from "./settings.js";
import { SecretsSettings } from "./secrets.js";

/**
 * The client bundle entry: mounts the Remote endpoints and registers the
 * bundle's UI contributions into the dsh Web slots. The contributed views
 * themselves live next to this file, one module per feature.
 */
export const inject = ["remote", "slots"];

/** Mount the Remote endpoints, replace folder picking with repository entry,
 * and add the Instructions, Secrets, and Sandboxes sections to the Settings
 * page. */
export async function apply(ctx: Context) {
  const disposeRemote = await ctx.remote.$mount(yawnRemote);

  const unwrap = <T,>(result: RemoteResult<T>): T => {
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  };

  ctx.inject(["remote.sandboxManager"], (remoteCtx) => {
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
      "settings.section",
      function* registerSettingsSections() {
        yield remoteCtx.slots.register(
          {
            name: "settings.section",
            id: "dsh-yawn.instructions",
            order: 30,
            label: "Instructions",
            inject: injectedInstructions,
          },
          InstructionsSettings,
        );
        yield remoteCtx.slots.register(
          {
            name: "settings.section",
            id: "dsh-yawn.secrets",
            order: 31,
            label: "Secrets",
            inject: injected,
          },
          SecretsSettings,
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
            id: "dsh-yawn.profile",
            inject: injectedProfile,
          },
          SandboxProfileChip,
        );
      },
    );
    const injectedStatus = () => ({
      getSandboxStatus: async (sessionId: string) =>
        unwrap(
          await remoteCtx.remote.sandboxManager.getSandboxStatus(sessionId),
        ),
    });
    remoteCtx.slots.inject(
      "conversation.view",
      function* registerSandboxView() {
        yield remoteCtx.slots.register(
          {
            name: "conversation.view",
            id: "dsh-yawn.sandbox",
            // After Chat (0) and Trajectory (10).
            order: 20,
            label: () => "Sandbox",
            inject: (sessionId) => ({
              sessionId,
              ...injectedStatus(),
            }),
          },
          SandboxStatusTab,
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

  // The stock settings controller's namespaces are traced services: a consumer
  // must name `remote.settings` and `remote.credentials` in its own inject.
  // The Sandboxes page talks to them directly rather than through the stock
  // browser mirror, which keeps settings writes process-local on every
  // non-loopback page — every page of a deployed control plane. Credential
  // writes are write-only and land in the host document, never in a sandbox.
  ctx.inject(["remote.settings", "remote.credentials"], (settingsCtx) => {
    const settings = settingsCtx.remote.settings;
    const credentials = settingsCtx.remote.credentials;
    settingsCtx.slots.inject(
      "settings.section",
      function* registerSandboxesSection() {
        yield settingsCtx.slots.register(
          {
            name: "settings.section",
            id: "dsh-yawn.sandboxes",
            order: 32,
            label: "Sandboxes",
            inject: () => ({
              describeSettings: async () => unwrap(await settings.describe()),
              updateSettings: async (
                ns: string,
                patch: Record<string, JsonValue>,
                expectedRevision: number | undefined,
              ) => unwrap(await settings.update(ns, patch, expectedRevision)),
              mutateSettings: async (
                ns: string,
                ops: SettingsPathOpView[],
                expectedRevision: number | undefined,
              ) => unwrap(await settings.mutate(ns, ops, expectedRevision)),
              replaceSettings: async (
                ns: string,
                section: Record<string, JsonValue>,
                expectedRevision: number | undefined,
              ) =>
                unwrap(await settings.replace(ns, section, expectedRevision)),
              describeCredentials: async (refs: string[]) =>
                unwrap(await credentials.describe(refs)),
              setCredential: async (ref: string, value: string) => {
                unwrap(await credentials.set(ref, value));
              },
              unsetCredential: async (ref: string) => {
                unwrap(await credentials.unset(ref));
              },
            }),
          },
          SandboxesSettings,
        );
      },
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
