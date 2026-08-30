import { useEffect, useState, type FormEvent } from "react";

import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SidebarFooterActionOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";

interface SecretsActions {
  listSecrets(): Promise<string[]>;
  setSecret(name: string, value: string): Promise<string[]>;
  deleteSecret(name: string): Promise<string[]>;
}

interface SecretsFooterActionProps
  extends SidebarFooterActionOwnerProps,
    SecretsActions {}

/** Sidebar foot trigger beside Settings that opens the secrets manager. */
export function SecretsFooterAction({
  wide,
  ...actions
}: SecretsFooterActionProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title="Secrets"
        onClick={() => setOpen(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: wide ? "100%" : 36,
          height: 36,
          justifyContent: wide ? "flex-start" : "center",
          padding: wide ? "0 8px" : 0,
          background: "none",
          border: "none",
          borderRadius: 8,
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        <KeyIcon />
        {wide ? <span>Secrets</span> : null}
      </button>
      {open ? (
        <SecretsModal {...actions} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function KeyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: "none" }}
    >
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2m-3 3 3 3m-6 0 2 2" />
    </svg>
  );
}

interface SecretsModalProps extends SecretsActions {
  onClose(): void;
}

/** Name/value CRUD over the host credential broker. Values are write-only. */
function SecretsModal({
  listSecrets,
  setSecret,
  deleteSecret,
  onClose,
}: SecretsModalProps) {
  const [names, setNames] = useState<string[]>();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    listSecrets().then(setNames, (reason) => setError(describe(reason)));
  }, [listSecrets]);

  const run = async (action: () => Promise<string[]>): Promise<boolean> => {
    setPending(true);
    setError(undefined);
    try {
      setNames(await action());
      return true;
    } catch (reason) {
      setError(describe(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (pending || trimmed === "" || value === "") return;
    if (await run(() => setSecret(trimmed, value))) {
      setName("");
      setValue("");
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Secrets"
      description="Environment variables injected into every sandbox command."
      closeLabel="Close"
      className="dsh-workbench-secrets-dialog"
      footer={
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      }
    >
      {names === undefined && error === undefined ? (
        <p style={{ margin: 0, opacity: 0.7 }}>Loading…</p>
      ) : null}
      {names !== undefined && names.length === 0 ? (
        <p style={{ margin: 0, opacity: 0.7 }}>No secrets yet.</p>
      ) : null}
      {names !== undefined && names.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {names.map((secretName) => (
            <li
              key={secretName}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "4px 0",
              }}
            >
              <code>{secretName}</code>
              <Button
                type="button"
                disabled={pending}
                onClick={() => run(() => deleteSecret(secretName))}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 12,
        }}
      >
        <Input
          aria-label="Secret name"
          placeholder="NAME"
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.currentTarget.value)}
          style={{ width: "100%" }}
        />
        <Input
          aria-label="Secret value"
          type="password"
          placeholder="value"
          autoComplete="off"
          value={value}
          disabled={pending}
          onChange={(event) => setValue(event.currentTarget.value)}
          style={{ width: "100%" }}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={pending || name.trim() === "" || value === ""}
          style={{ alignSelf: "flex-end" }}
        >
          Save
        </Button>
      </form>
      {error === undefined ? (
        <p style={{ margin: "8px 0 0", opacity: 0.7, fontSize: 13 }}>
          A secret named <code>GITHUB_TOKEN</code> also serves as the Git
          credential for github.com repositories.
        </p>
      ) : (
        <p
          role="alert"
          style={{ margin: "8px 0 0", color: "var(--dsw-color-error)" }}
        >
          {error}
        </p>
      )}
    </Modal>
  );
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
