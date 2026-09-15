import { useEffect, useState, type CSSProperties, type FormEvent } from "react";

import { Button, Input, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  SettingsDescribeValue,
  SettingsNamespaceView,
  SettingsPathOpView,
} from "@deepseek-ai/dsh-api-remotes/client";
import type { CredentialInfo } from "@deepseek-ai/dsh-credentials/types";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import { defaultBuildkiteTokenCredential } from "../buildkite-credential.js";

/** The `sandbox-manager` namespace this page edits. */
const NS = "sandbox-manager";

export interface SandboxesSettingsActions {
  describeSettings: () => Promise<SettingsDescribeValue>;
  updateSettings: (
    ns: string,
    patch: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ) => Promise<SettingsNamespaceView>;
  mutateSettings: (
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ) => Promise<SettingsNamespaceView>;
  replaceSettings: (
    ns: string,
    section: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ) => Promise<SettingsNamespaceView>;
  describeCredentials: (
    refs: string[],
  ) => Promise<Record<string, CredentialInfo>>;
  setCredential: (ref: string, value: string) => Promise<void>;
  unsetCredential: (ref: string) => Promise<void>;
}

type SandboxesSettingsProps = SettingsSectionOwnerProps &
  SandboxesSettingsActions;

/** One profile as the settings document carries it: a backend plus fields. */
interface ProfileDraft {
  name: string;
  backend: string;
  fields: Record<string, string>;
}

/** The runtime slice as it rides the wire, defaults already applied. */
interface RuntimeWire {
  profiles?: Record<string, Record<string, JsonValue>>;
  defaultProfile?: string;
  idleMs?: number;
  expiresAfterMs?: number;
}

const BACKENDS = ["docker", "kas", "buildkite"] as const;

/** Text inputs per backend, in display order; `number` fields parse as ints. */
const BACKEND_FIELDS: Record<
  string,
  Array<{ key: string; label: string; kind?: "number" }>
> = {
  docker: [
    { key: "image", label: "Runner image (optional)" },
    { key: "binary", label: "Docker command (optional)" },
    { key: "controlPlaneUrl", label: "Control plane URL (optional)" },
  ],
  kas: [
    { key: "namespace", label: "Namespace" },
    { key: "warmPool", label: "Warm pool" },
    { key: "readyTimeoutMs", label: "Ready timeout (ms)", kind: "number" },
    { key: "kubeconfig", label: "Kubeconfig path (optional)" },
  ],
  buildkite: [
    { key: "organization", label: "Organization" },
    { key: "pipeline", label: "Pipeline" },
    { key: "controlPlaneUrl", label: "Control plane URL" },
    { key: "image", label: "Runner image (optional)" },
    { key: "readyTimeoutMs", label: "Ready timeout (ms)", kind: "number" },
  ],
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// The settings page's own vocabulary, matching the cards this package already
// contributes: token-styled native controls, labels above them, and primitives
// for action hierarchy.
const labelStyle: CSSProperties = {
  display: "block",
  margin: "12px 0 6px",
  fontWeight: 500,
};

const controlStyle: CSSProperties = {
  width: "100%",
  minHeight: 38,
  boxSizing: "border-box",
  padding: "7px 10px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1)",
  padding: "10px 12px",
};

const sectionHeadingStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 16,
  fontWeight: 600,
};

/**
 * Settings page for sandbox profiles and lifecycle timers. Reads the layered
 * view the settings service serves — deployment base, user overrides, resolved
 * value — and writes only the user layer, so everything the deployment
 * configures stays one reset away and edits apply on the host without a
 * restart.
 */
export function SandboxesSettings({
  describeSettings,
  updateSettings,
  mutateSettings,
  replaceSettings,
  describeCredentials,
  setCredential,
  unsetCredential,
}: SandboxesSettingsProps) {
  const [view, setView] = useState<SettingsNamespaceView>();
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft | undefined>();
  /** The Buildkite token typed in this form; never read back from the host. */
  const [token, setToken] = useState("");
  const [tokenInfo, setTokenInfo] = useState<CredentialInfo>();

  useEffect(() => {
    let cancelled = false;
    describeSettings()
      .then((described) => {
        if (cancelled) {
          return;
        }
        setWritable(described.writable);
        const found = described.namespaces.find((entry) => entry.ns === NS);
        if (found === undefined) {
          setError("the host did not register its sandbox-manager settings");
          return;
        }
        setView(found);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(describeError(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [describeSettings]);

  const write = async (
    action: (revision: number | undefined) => Promise<SettingsNamespaceView>,
  ): Promise<SettingsNamespaceView | undefined> => {
    if (view === undefined || pending) {
      return undefined;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await action(view.revision);
      setView(next);
      return next;
    } catch (reason) {
      setError(describeError(reason));
      // The revision may have moved under us (a concurrent editor, or a
      // direct edit of the settings document): re-read so the page shows
      // what actually landed.
      describeSettings()
        .then((described) => {
          const found = described.namespaces.find((entry) => entry.ns === NS);
          if (found !== undefined) {
            setView(found);
          }
        })
        .catch(() => {});
      return undefined;
    } finally {
      setPending(false);
    }
  };

  const value = (view?.value ?? {}) as RuntimeWire;
  const user = (view?.user ?? {}) as RuntimeWire;
  const profiles = value.profiles ?? {};
  const profileNames = Object.keys(profiles).sort();
  // The credential the host stores this profile's token under: derived from
  // the profile name, and never shown or edited. The name is shared with the
  // host through the same derivation, so the settings wire need not carry it.
  const draftTokenRef =
    draft?.backend === "buildkite"
      ? defaultBuildkiteTokenCredential(draft.name)
      : "";
  const tokenStored =
    tokenInfo?.configured === true && tokenInfo.source !== "env";

  useEffect(() => {
    if (draftTokenRef === "") {
      setTokenInfo(undefined);
      return;
    }
    let cancelled = false;
    describeCredentials([draftTokenRef])
      .then((described) => {
        if (!cancelled) {
          setTokenInfo(described[draftTokenRef]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTokenInfo(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [describeCredentials, draftTokenRef]);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft === undefined) {
      return;
    }
    const fields: Record<string, JsonValue> = {
      backend: draft.backend,
    };
    for (const field of BACKEND_FIELDS[draft.backend] ?? []) {
      const raw = draft.fields[field.key]?.trim();
      if (raw === undefined || raw === "") {
        continue;
      }
      fields[field.key] =
        field.kind === "number" ? Number.parseInt(raw, 10) : raw;
    }
    // The profile is written first, then the token under the name derived
    // from the profile. The credential document is host-side, never pushed
    // into a sandbox.
    const saved = await write((revision) =>
      mutateSettings(
        NS,
        [
          {
            op: "set",
            path: ["profiles", draft.name],
            value: fields,
          },
        ],
        revision,
      ),
    );
    if (saved === undefined) {
      return;
    }
    if (draft.backend === "buildkite" && token !== "") {
      const ref = defaultBuildkiteTokenCredential(draft.name);
      setPending(true);
      try {
        await setCredential(ref, token);
        setToken("");
        describeCredentials([ref])
          .then((described) => setTokenInfo(described[ref]))
          .catch(() => {});
      } catch (reason) {
        // The profile itself is saved; keep the form open with the typed
        // token so Save retries only the credential write.
        setError(
          `the profile was saved, but the token could not be stored: ${describeError(reason)}`,
        );
        return;
      } finally {
        setPending(false);
      }
    }
    setNotice(`saved profile ${draft.name}`);
    setDraft(undefined);
  };

  const clearToken = async () => {
    if (draft === undefined || draftTokenRef === "") {
      return;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await unsetCredential(draftTokenRef);
      setTokenInfo((current) =>
        current === undefined ? current : { ...current, configured: false },
      );
      setNotice(`cleared the stored token for ${draft.name}`);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setPending(false);
    }
  };

  const removeProfile = (name: string) => {
    void write((revision) =>
      mutateSettings(NS, [{ op: "unset", path: ["profiles", name] }], revision),
    ).then((removed) => {
      if (removed) {
        setNotice(`removed profile ${name}`);
      }
    });
  };

  const setTimer = (key: "idleMs" | "expiresAfterMs", minutes: number) => {
    void write((revision) =>
      updateSettings(NS, { [key]: minutes * MINUTE }, revision),
    ).then((saved) => {
      if (saved) {
        setNotice("saved");
      }
    });
  };

  const unsetField = (path: string[], note: string) => {
    void write((revision) =>
      mutateSettings(NS, [{ op: "unset", path }], revision),
    ).then((done) => {
      if (done) {
        setNotice(note);
      }
    });
  };

  const setDefaultProfile = (name: string) => {
    void write((revision) =>
      updateSettings(NS, { defaultProfile: name }, revision),
    ).then((saved) => {
      if (saved) {
        setNotice("saved the default profile");
      }
    });
  };

  const anyOverride =
    user.profiles !== undefined ||
    user.defaultProfile !== undefined ||
    user.idleMs !== undefined ||
    user.expiresAfterMs !== undefined;

  return (
    <section style={{ maxWidth: 760, color: "var(--dsw-alias-label-primary)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Sandboxes</h2>
      <p
        style={{
          margin: "0 0 24px",
          color: "var(--dsw-alias-label-secondary)",
          lineHeight: 1.5,
        }}
      >
        Sandbox profiles and lifecycle timers. Changes apply on the host without
        a restart; sessions that already have a sandbox keep it. Fields the
        deployment configures are marked <em>deployment</em>, and a reset
        returns to them.
      </p>

      {view === undefined && error === undefined ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          Loading…
        </p>
      ) : null}

      {view !== undefined ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              margin: "0 0 12px",
            }}
          >
            <h3 style={{ ...sectionHeadingStyle, margin: 0 }}>Profiles</h3>
            {draft === undefined ? (
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={pending || !writable}
                onClick={() =>
                  setDraft({ name: "", backend: "docker", fields: {} })
                }
              >
                New profile
              </Button>
            ) : null}
          </div>

          {profileNames.length === 0 ? (
            <p
              style={{
                ...cardStyle,
                margin: 0,
                color: "var(--dsw-alias-label-secondary)",
              }}
            >
              No sandbox profiles yet. Add one below, or the first message of a
              session cannot start a sandbox.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {profileNames.map((name) => {
                const profile = profiles[name];
                const backend =
                  typeof profile?.backend === "string" ? profile.backend : "";
                const custom = user.profiles?.[name] !== undefined;
                const fields = stringFields(profile);
                const summary = Object.entries(fields)
                  .map(([key, entry]) => `${key}: ${entry}`)
                  .join(", ");
                return (
                  <div key={name} style={cardStyle}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                          minWidth: 0,
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{name}</span>
                        <Tag tone="neutral">{backend}</Tag>
                        <Tag tone={custom ? "info" : "quiet"}>
                          {custom ? "custom" : "deployment"}
                        </Tag>
                        {value.defaultProfile === name ? (
                          <Tag tone="outline">default</Tag>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending || !writable}
                          onClick={() =>
                            setDraft({
                              name,
                              backend: backend === "" ? "docker" : backend,
                              fields: { ...fields },
                            })
                          }
                        >
                          Edit
                        </Button>
                        {custom ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={pending || !writable}
                            onClick={() => removeProfile(name)}
                          >
                            Reset
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {summary !== "" ? (
                      <div
                        style={{
                          marginTop: 6,
                          color: "var(--dsw-alias-label-secondary)",
                          fontSize: 13,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {summary}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {draft !== undefined ? (
            <form
              onSubmit={saveProfile}
              style={{ ...cardStyle, marginTop: 12, padding: 16 }}
            >
              <h3 style={sectionHeadingStyle}>
                {profileNames.includes(draft.name) && draft.name !== ""
                  ? `Edit ${draft.name}`
                  : "New profile"}
              </h3>
              <label htmlFor="dsh-yawn-profile-name" style={labelStyle}>
                Name
              </label>
              <Input
                id="dsh-yawn-profile-name"
                placeholder="standard"
                value={draft.name}
                disabled={pending}
                onChange={(event) => {
                  // Read the value now: the state updater runs after dispatch,
                  // when currentTarget is already null.
                  const name = event.currentTarget.value;
                  setDraft((current) =>
                    current === undefined ? current : { ...current, name },
                  );
                }}
                style={{ width: "100%" }}
              />
              <label htmlFor="dsh-yawn-profile-backend" style={labelStyle}>
                Backend
              </label>
              <select
                id="dsh-yawn-profile-backend"
                value={draft.backend}
                disabled={pending}
                onChange={(event) => {
                  const backend = event.currentTarget.value;
                  setDraft((current) =>
                    current === undefined ? current : { ...current, backend },
                  );
                }}
                style={controlStyle}
              >
                {BACKENDS.map((backend) => (
                  <option key={backend} value={backend}>
                    {backend}
                  </option>
                ))}
              </select>
              {(BACKEND_FIELDS[draft.backend] ?? []).map((field) => (
                <div key={field.key}>
                  <label
                    htmlFor={`dsh-yawn-profile-field-${field.key}`}
                    style={labelStyle}
                  >
                    {field.label}
                  </label>
                  <Input
                    id={`dsh-yawn-profile-field-${field.key}`}
                    inputMode={field.kind === "number" ? "numeric" : undefined}
                    value={draft.fields[field.key] ?? ""}
                    disabled={pending}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setDraft((current) =>
                        current === undefined
                          ? current
                          : {
                              ...current,
                              fields: { ...current.fields, [field.key]: value },
                            },
                      );
                    }}
                    style={{ width: "100%" }}
                  />
                </div>
              ))}
              {draft.backend === "buildkite" ? (
                <div>
                  <label htmlFor="dsh-yawn-buildkite-token" style={labelStyle}>
                    API token
                  </label>
                  <Input
                    id="dsh-yawn-buildkite-token"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      tokenStored
                        ? "stored (write-only)"
                        : tokenInfo?.configured
                          ? "supplied by the environment"
                          : "paste an API token"
                    }
                    value={token}
                    disabled={pending}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      setToken(next);
                    }}
                    style={{ width: "100%" }}
                  />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginTop: 6,
                      color: "var(--dsw-alias-label-secondary)",
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                  >
                    <span>
                      {tokenStored
                        ? "Stored write-only on the control plane for this profile. It never reaches a sandbox."
                        : tokenInfo?.configured
                          ? "Currently supplied by an environment variable on the control plane."
                          : "Used for this profile's Buildkite API calls. Stored write-only on the control plane; it never reaches a sandbox."}
                    </span>
                    {tokenStored ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => void clearToken()}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  marginTop: 20,
                }}
              >
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => setDraft(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={pending || !writable || draft.name.trim() === ""}
                >
                  {pending ? "Saving…" : "Save profile"}
                </Button>
              </div>
            </form>
          ) : null}

          <h3 style={{ ...sectionHeadingStyle, margin: "28px 0 12px" }}>
            Defaults
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              ...cardStyle,
              padding: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span style={{ flex: "0 0 200px" }}>Default profile</span>
              <select
                aria-label="Default profile"
                value={value.defaultProfile ?? ""}
                disabled={pending || !writable || profileNames.length === 0}
                onChange={(event) =>
                  setDefaultProfile(event.currentTarget.value)
                }
                style={{ ...controlStyle, width: 200 }}
              >
                {profileNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              {user.defaultProfile !== undefined ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending || !writable}
                  onClick={() =>
                    unsetField(["defaultProfile"], "reset the default profile")
                  }
                >
                  Reset
                </Button>
              ) : null}
            </div>
            <TimerRow
              label="Idle delay before hibernating"
              unit="minutes"
              current={
                value.idleMs !== undefined ? value.idleMs / MINUTE : undefined
              }
              overridden={user.idleMs !== undefined}
              disabled={pending || !writable}
              onSave={(minutes) => setTimer("idleMs", minutes)}
              onReset={() => unsetField(["idleMs"], "reset the idle delay")}
            />
            <TimerRow
              label="Retention of hibernated workspaces"
              unit="days"
              current={
                value.expiresAfterMs !== undefined
                  ? value.expiresAfterMs / DAY
                  : undefined
              }
              overridden={user.expiresAfterMs !== undefined}
              disabled={pending || !writable}
              onSave={(days) => setTimer("expiresAfterMs", days * 24 * 60)}
              onReset={() =>
                unsetField(["expiresAfterMs"], "reset the retention window")
              }
            />
          </div>

          {anyOverride ? (
            <p style={{ margin: "16px 0 0" }}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || !writable}
                onClick={() =>
                  void write((revision) =>
                    replaceSettings(NS, {}, revision),
                  ).then((done) => {
                    if (done) {
                      setNotice(
                        "returned every field to the deployment settings",
                      );
                    }
                  })
                }
              >
                Reset everything to deployment settings
              </Button>
            </p>
          ) : null}
        </>
      ) : null}

      {notice !== undefined ? (
        <p
          role="status"
          style={{
            margin: "12px 0 0",
            color: "var(--dsw-alias-state-success-primary)",
          }}
        >
          {notice}
        </p>
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
          margin: "28px 0 0",
          color: "var(--dsw-alias-label-secondary)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Profiles are layered over the deployment's configuration: a reset
        returns a field to what the chart or the settings file configures. The
        settings document is <code>$DSH_HOME/settings.yaml</code>, editable by
        hand and hot-reloaded.
      </p>
    </section>
  );
}

function TimerRow({
  label,
  unit,
  current,
  overridden,
  disabled,
  onSave,
  onReset,
}: {
  label: string;
  unit: string;
  current: number | undefined;
  overridden: boolean;
  disabled: boolean;
  onSave: (steps: number) => void;
  onReset: () => void;
}) {
  const [text, setText] = useState("");
  const rounded = current === undefined ? undefined : Math.round(current);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: "0 0 200px" }}>
        {label}
        <div
          style={{
            color: "var(--dsw-alias-label-secondary)",
            fontSize: 13,
          }}
        >
          {rounded === undefined ? "—" : `${rounded} ${unit}`} ·{" "}
          {overridden ? "custom" : "deployment"}
        </div>
      </div>
      <Input
        aria-label={`${label} in ${unit}`}
        placeholder={unit}
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
        }}
        style={{ width: 120 }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={
          disabled || text === "" || Number.isNaN(Number.parseInt(text, 10))
        }
        onClick={() => {
          onSave(Number.parseInt(text, 10));
          setText("");
        }}
      >
        Save
      </Button>
      {overridden ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onReset}
        >
          Reset
        </Button>
      ) : null}
    </div>
  );
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** The scalar fields of a wire profile, `backend` aside, for display and edit. */
function stringFields(
  profile: Record<string, JsonValue> | undefined,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, entry] of Object.entries(profile ?? {})) {
    if (
      key !== "backend" &&
      (typeof entry === "string" || typeof entry === "number")
    ) {
      fields[key] = String(entry);
    }
  }
  return fields;
}
