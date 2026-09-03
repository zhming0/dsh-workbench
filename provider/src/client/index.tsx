import { useEffect, useRef, useState, type FormEvent } from "react";

import type { Context } from "@deepseek-ai/cordis";
// These two type-only imports load the declaration merges that put `remote`
// and `slots` on the browser Context.
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { DirectoryFlowOwnerProps } from "@deepseek-ai/dsh-client-ui-workspace/client";

import { workbenchRemote } from "../remote-contributions.js";
import { InstructionsSettings } from "./instructions.js";
import { SandboxProfileChip } from "./profile.js";
import { SecretsFooterAction } from "./secrets.js";

interface RepositoryDirectoryFlowProps extends DirectoryFlowOwnerProps {
  createWorkspaceAnchor: (repositoryUrl: string) => Promise<string>;
}

/** Repository URL dialog occupying dsh's two Workspace directory-flow slots. */
export function RepositoryDirectoryFlow({
  open,
  busy,
  onPicked,
  onCancel,
  createWorkspaceAnchor,
}: RepositoryDirectoryFlowProps) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setRepositoryUrl("");
      setPending(false);
      setError(undefined);
    }
    wasOpen.current = open;
  }, [open]);

  const disabled = pending || busy;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      onPicked(await createWorkspaceAnchor(repositoryUrl));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!disabled) {
          onCancel();
        }
      }}
      title="Add repository"
      description="Create an isolated workspace from a Git repository."
      closeLabel="Close"
      className="dsh-workbench-repository-dialog"
      footer={
        <>
          <Button type="button" onClick={onCancel} disabled={disabled}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="dsh-workbench-repository-form"
            variant="primary"
            disabled={disabled || repositoryUrl.trim().length === 0}
          >
            {disabled ? "Adding…" : "Add repository"}
          </Button>
        </>
      }
    >
      <form id="dsh-workbench-repository-form" onSubmit={submit}>
        <label
          htmlFor="dsh-workbench-repository-url"
          style={{ display: "block", marginBottom: 8, fontWeight: 500 }}
        >
          Repository URL
        </label>
        <Input
          id="dsh-workbench-repository-url"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoFocus
          placeholder="https://github.com/owner/repository"
          value={repositoryUrl}
          disabled={disabled}
          onChange={(event) => setRepositoryUrl(event.currentTarget.value)}
          aria-describedby={
            error === undefined
              ? "dsh-workbench-repository-hint"
              : "dsh-workbench-repository-error"
          }
          style={{ width: "100%" }}
        />
        {error === undefined ? (
          <p
            id="dsh-workbench-repository-hint"
            style={{ margin: "8px 0 0", opacity: 0.7, fontSize: 13 }}
          >
            HTTPS and SSH repository URLs are supported.
          </p>
        ) : (
          <p
            id="dsh-workbench-repository-error"
            role="alert"
            style={{ margin: "8px 0 0", color: "var(--dsw-color-error)" }}
          >
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

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
