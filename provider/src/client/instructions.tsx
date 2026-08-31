import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { InstructionSettingsView } from "../instructions-remote.js";

const GLOBAL_SCOPE = "__global__";

interface InstructionActions {
  getInstructions(): Promise<InstructionSettingsView>;
  setGlobalInstructions(content: string): Promise<InstructionSettingsView>;
  setWorkspaceInstructions(
    repositoryUrl: string,
    content: string,
  ): Promise<InstructionSettingsView>;
}

interface InstructionsSettingsProps
  extends SettingsSectionOwnerProps,
    InstructionActions {}

/** Settings page for UI-managed global and per-repository AGENTS.md layers. */
export function InstructionsSettings({
  getInstructions,
  setGlobalInstructions,
  setWorkspaceInstructions,
}: InstructionsSettingsProps) {
  const [settings, setSettings] = useState<InstructionSettingsView>();
  const [scope, setScope] = useState(GLOBAL_SCOPE);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    getInstructions().then(
      (loaded) => {
        setSettings(loaded);
        setDraft(loaded.global);
      },
      (reason) => setError(describe(reason)),
    );
  }, [getInstructions]);

  const saved = contentFor(settings, scope);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || settings === undefined) return;
    setPending(true);
    setStatus(undefined);
    setError(undefined);
    try {
      const updated =
        scope === GLOBAL_SCOPE
          ? await setGlobalInstructions(draft)
          : await setWorkspaceInstructions(scope, draft);
      setSettings(updated);
      setDraft(contentFor(updated, scope));
      setStatus("Saved");
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <section style={{ maxWidth: 760, color: "var(--dsw-alias-label-primary)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>AGENTS.md</h2>
      <p
        style={{
          margin: "0 0 24px",
          color: "var(--dsw-alias-label-secondary)",
          lineHeight: 1.5,
        }}
      >
        Add instructions without changing a repository. Global instructions
        apply everywhere; workspace instructions add guidance for one
        repository.
      </p>

      {settings === undefined && error === undefined ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          Loading…
        </p>
      ) : null}

      {settings !== undefined ? (
        <form onSubmit={save}>
          <label
            htmlFor="dsh-workbench-instruction-scope"
            style={{ display: "block", marginBottom: 8, fontWeight: 500 }}
          >
            Scope
          </label>
          <select
            id="dsh-workbench-instruction-scope"
            value={scope}
            disabled={pending}
            onChange={(event) => {
              const nextScope = event.currentTarget.value;
              setScope(nextScope);
              setDraft(contentFor(settings, nextScope));
              setStatus(undefined);
              setError(undefined);
            }}
            style={{
              width: "100%",
              minHeight: 38,
              padding: "7px 10px",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 8,
              background: "var(--dsw-alias-bg-layer-1)",
              color: "var(--dsw-alias-label-primary)",
              font: "inherit",
            }}
          >
            <option value={GLOBAL_SCOPE}>Global · All workspaces</option>
            {settings.workspaces.map((workspace) => (
              <option
                key={workspace.repositoryUrl}
                value={workspace.repositoryUrl}
              >
                Workspace · {workspace.title}
              </option>
            ))}
          </select>

          <label
            htmlFor="dsh-workbench-instructions"
            style={{ display: "block", margin: "20px 0 8px", fontWeight: 500 }}
          >
            Markdown instructions
          </label>
          <textarea
            id="dsh-workbench-instructions"
            value={draft}
            disabled={pending}
            spellCheck={false}
            placeholder={
              scope === GLOBAL_SCOPE
                ? "Instructions for every workspace…"
                : "Instructions for this repository…"
            }
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setStatus(undefined);
            }}
            style={{
              display: "block",
              width: "100%",
              minHeight: 280,
              resize: "vertical",
              boxSizing: "border-box",
              padding: 12,
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 8,
              background: "var(--dsw-alias-bg-layer-1)",
              color: "var(--dsw-alias-label-primary)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 12,
            }}
          >
            <span
              style={{
                color: "var(--dsw-alias-label-tertiary)",
                fontSize: 13,
              }}
            >
              {new TextEncoder().encode(draft).length.toLocaleString()} bytes
            </span>
            <Button
              type="submit"
              variant="primary"
              disabled={pending || draft === saved}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>

          {status !== undefined ? (
            <p
              role="status"
              style={{
                margin: "12px 0 0",
                color: "var(--dsw-alias-state-success-primary)",
              }}
            >
              {status}
            </p>
          ) : null}
        </form>
      ) : null}

      {error !== undefined ? (
        <p
          role="alert"
          style={{
            margin: "12px 0 0",
            color: "var(--dsw-alias-state-error-primary)",
          }}
        >
          {error}
        </p>
      ) : null}

      <p
        style={{
          margin: "24px 0 0",
          color: "var(--dsw-alias-label-secondary)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Changes apply to the next model request, usually after your next
        message. Checked-in and nested AGENTS.md files remain active. Empty the
        editor and save to clear this scope. Global plus workspace instructions
        may total up to 65,536 UTF-8 bytes.
      </p>
    </section>
  );
}

function contentFor(
  settings: InstructionSettingsView | undefined,
  scope: string,
): string {
  if (settings === undefined) return "";
  if (scope === GLOBAL_SCOPE) return settings.global;
  return (
    settings.workspaces.find((workspace) => workspace.repositoryUrl === scope)
      ?.content ?? ""
  );
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
