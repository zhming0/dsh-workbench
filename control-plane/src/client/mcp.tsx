import { useEffect, useState, type FormEvent } from "react";

import { Button, Input, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import type { McpServerView } from "../mcp-remote.js";
import type { McpServerEntry } from "../mcp-store.js";

interface McpActions {
  listMcpServers: () => Promise<McpServerView[]>;
  setMcpServer: (entry: McpServerEntry) => Promise<McpServerView[]>;
  deleteMcpServer: (serverName: string) => Promise<McpServerView[]>;
  testMcpServer: (
    entry: McpServerEntry,
  ) => Promise<{ ok: boolean; toolCount: number; error?: string }>;
}

interface McpSettingsProps extends SettingsSectionOwnerProps, McpActions {}

/** Settings page for remote Streamable HTTP MCP servers. Tokens are write-only. */
export function McpSettings({
  listMcpServers,
  setMcpServer,
  deleteMcpServer,
  testMcpServer,
}: McpSettingsProps) {
  const [servers, setServers] = useState<McpServerView[]>();
  const [editing, setEditing] = useState<string>();
  const [serverName, setServerName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    listMcpServers().then(setServers, (reason) => setError(describe(reason)));
  }, [listMcpServers]);

  const edited = servers?.find((server) => server.serverName === editing);

  const draft = (): McpServerEntry | undefined => {
    const name = serverName.trim();
    const endpoint = url.trim();
    if (name === "" || endpoint === "") {
      return undefined;
    }
    const entry: McpServerEntry = { serverName: name, url: endpoint, enabled };
    // Blank means "keep the saved token"; the host applies the same rule.
    return token === "" ? entry : { ...entry, token };
  };

  const reset = () => {
    setEditing(undefined);
    setServerName("");
    setUrl("");
    setToken("");
    setEnabled(true);
    setTestResult(undefined);
  };

  const run = async (
    action: () => Promise<McpServerView[]>,
  ): Promise<boolean> => {
    setPending(true);
    setError(undefined);
    try {
      setServers(await action());
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
    const entry = draft();
    if (pending || entry === undefined) {
      return;
    }
    setTestResult(undefined);
    if (await run(() => setMcpServer(entry))) {
      reset();
    }
  };

  const test = async () => {
    const entry = draft();
    if (pending || entry === undefined) {
      return;
    }
    setPending(true);
    setError(undefined);
    setTestResult(undefined);
    try {
      const result = await testMcpServer(entry);
      setTestResult(
        result.ok
          ? {
              ok: true,
              text: `Connected: ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}.`,
            }
          : { ok: false, text: `Failed: ${result.error ?? "unknown error"}` },
      );
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setPending(false);
    }
  };

  const edit = (server: McpServerView) => {
    setEditing(server.serverName);
    setServerName(server.serverName);
    setUrl(server.url);
    setToken("");
    setEnabled(server.enabled);
    setTestResult(undefined);
    setError(undefined);
  };

  const remove = async (name: string) => {
    if (await run(() => deleteMcpServer(name))) {
      if (editing === name) {
        reset();
      }
    }
  };

  return (
    <section style={{ maxWidth: 760, color: "var(--dsw-alias-label-primary)" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>MCP</h2>
      <p
        style={{
          margin: "0 0 24px",
          color: "var(--dsw-alias-label-secondary)",
          lineHeight: 1.5,
        }}
      >
        Remote MCP servers reached over Streamable HTTP. Each server's tools
        join the model's tool list as <code>mcp__name__tool</code>. A token is
        sent as an <code>Authorization: Bearer</code> header, stored write-only
        on the host, and never shown again. Changes apply to new tool calls
        without restarting the host.
      </p>

      {servers === undefined && error === undefined ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          Loading…
        </p>
      ) : null}
      {servers !== undefined && servers.length === 0 ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          No MCP servers configured.
        </p>
      ) : null}
      {servers !== undefined && servers.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {servers.map((server) => (
            <li
              key={server.serverName}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 0",
                borderTop: "1px solid var(--dsw-alias-border-l2)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{ display: "flex", gap: 8, alignItems: "baseline" }}
                >
                  <code>{server.serverName}</code>
                  <span
                    style={{
                      color: statusColor(server.status),
                      fontSize: 13,
                    }}
                  >
                    {statusText(server)}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 2,
                    color: "var(--dsw-alias-label-tertiary)",
                    fontSize: 13,
                    overflowWrap: "anywhere",
                  }}
                >
                  {server.url}
                  {" · "}
                  {server.hasToken ? "token saved" : "no token"}
                </div>
                {server.error !== undefined ? (
                  <div
                    style={{
                      marginTop: 2,
                      color: "var(--dsw-alias-state-error-primary)",
                      fontSize: 13,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {server.error}
                  </div>
                ) : null}
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => edit(server)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => remove(server.serverName)}
                >
                  Delete
                </Button>
              </div>
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
          marginTop: 20,
        }}
      >
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>
          {editing === undefined ? "Add server" : `Edit ${editing}`}
        </h3>
        <Input
          aria-label="MCP server name"
          placeholder="serverName"
          value={serverName}
          disabled={pending || editing !== undefined}
          onChange={(event) => {
            setServerName(event.currentTarget.value);
            setTestResult(undefined);
          }}
          style={{ width: "100%" }}
        />
        <Input
          aria-label="MCP server URL"
          placeholder="https://example.com/mcp"
          value={url}
          disabled={pending}
          onChange={(event) => {
            setUrl(event.currentTarget.value);
            setTestResult(undefined);
          }}
          style={{ width: "100%" }}
        />
        <Input
          aria-label="MCP bearer token"
          type="password"
          placeholder={
            edited?.hasToken
              ? "a token is saved; leave blank to keep it"
              : "token (optional)"
          }
          autoComplete="off"
          value={token}
          disabled={pending}
          onChange={(event) => {
            setToken(event.currentTarget.value);
            setTestResult(undefined);
          }}
          style={{ width: "100%" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Switch
            checked={enabled}
            onChange={(next) => {
              setEnabled(next);
              setTestResult(undefined);
            }}
            label="Enabled"
            disabled={pending}
          />
          <span
            style={{ color: "var(--dsw-alias-label-secondary)", fontSize: 13 }}
          >
            Enabled
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <Button
            type="button"
            disabled={pending || draft() === undefined}
            onClick={test}
          >
            Test connection
          </Button>
          {editing !== undefined ? (
            <Button type="button" disabled={pending} onClick={reset}>
              Cancel
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            disabled={pending || draft() === undefined}
          >
            {editing === undefined ? "Add" : "Save"}
          </Button>
        </div>
      </form>

      {testResult !== undefined ? (
        <p
          role="status"
          style={{
            margin: "12px 0 0",
            color: testResult.ok
              ? "var(--dsw-alias-state-success-primary)"
              : "var(--dsw-alias-state-error-primary)",
          }}
        >
          {testResult.text}
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
          margin: "24px 0 0",
          color: "var(--dsw-alias-label-secondary)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Tools from an enabled server are available to every session on this
        host. A disabled server keeps its configuration and token but mounts
        nothing.
      </p>
    </section>
  );
}

function statusText(server: McpServerView): string {
  switch (server.status) {
    case "connected":
      return `connected · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
    case "starting":
      return "starting…";
    case "error":
      return "error";
    case "disabled":
      return "disabled";
  }
}

function statusColor(status: McpServerView["status"]): string {
  switch (status) {
    case "connected":
      return "var(--dsw-alias-state-success-primary)";
    case "error":
      return "var(--dsw-alias-state-error-primary)";
    default:
      return "var(--dsw-alias-label-tertiary)";
  }
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
