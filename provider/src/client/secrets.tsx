import { useEffect, useState, type FormEvent } from "react";

import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

interface SecretsActions {
  listSecrets: () => Promise<string[]>;
  setSecret: (name: string, value: string) => Promise<string[]>;
  deleteSecret: (name: string) => Promise<string[]>;
}

interface SecretsSettingsProps
  extends SettingsSectionOwnerProps,
    SecretsActions {}

/** Settings page for the host credential broker. Values are write-only. */
export function SecretsSettings({
  listSecrets,
  setSecret,
  deleteSecret,
}: SecretsSettingsProps) {
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
    if (pending || trimmed === "" || value === "") {
      return;
    }
    if (await run(() => setSecret(trimmed, value))) {
      setName("");
      setValue("");
    }
  };

  return (
    <section style={{ maxWidth: 760, color: "var(--dsw-alias-label-primary)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Secrets</h2>
      <p
        style={{
          margin: "0 0 24px",
          color: "var(--dsw-alias-label-secondary)",
          lineHeight: 1.5,
        }}
      >
        Environment variables injected into every sandbox command. Values are
        write-only: saving one stores it, and nothing reads it back.
      </p>

      {names === undefined && error === undefined ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          Loading…
        </p>
      ) : null}
      {names !== undefined && names.length === 0 ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          No secrets yet.
        </p>
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
        A secret named <code>GITHUB_TOKEN</code> also serves as the Git
        credential for github.com repositories. Sandbox code can read injected
        secrets, which is their purpose. The CLI edits the same store.
      </p>
    </section>
  );
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
