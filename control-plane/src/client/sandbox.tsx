import { useEffect, useState, type ReactNode } from "react";

import {
  fileSizeText,
  StateDot,
  type StateDotState,
} from "@deepseek-ai/dsh-client-ui-primitives";
// Type-only import for the declaration merge that defines the
// `conversation.view` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type {
  SandboxHostFacts,
  SandboxLiveFacts,
  SandboxStatusView,
} from "../sandbox-status-remote.js";

export interface SandboxStatusActions {
  getSandboxStatus: (sessionId: string) => Promise<SandboxStatusView>;
}

type SandboxStatusTabProps = PropsRuntime<"conversation.view"> &
  SandboxStatusActions;

/**
 * The Sandbox view: what the session's sandbox is, and what the machine says
 * about itself while it is up. Reads are subject to the same rule as the "@"
 * file index: they describe a hibernated sandbox without waking it, so the
 * host half is always there and the live half appears only when a runner is
 * already attached.
 */
export function SandboxStatusTab({
  sessionId: id,
  useSession,
  getSandboxStatus,
}: SandboxStatusTabProps) {
  const sessionId = String(id);
  const running = useSession((s) => s.running);
  const [view, setView] = useState<SandboxStatusView>();
  const [error, setError] = useState<string>();
  const [fetchedAt, setFetchedAt] = useState<number>();

  useEffect(() => {
    let cancelled = false;
    const fetch = () => {
      getSandboxStatus(sessionId).then(
        (next) => {
          if (!cancelled) {
            setView(next);
            setError(undefined);
            setFetchedAt(Date.now());
          }
        },
        (reason: unknown) => {
          if (!cancelled) {
            setError(describe(reason));
          }
        },
      );
    };
    fetch();
    // A turn is when a sandbox is provisioned, woken, or replaced, so the
    // view follows the turn while one runs. A hibernation has no such edge to
    // follow, hence the slower poll.
    const timer = setInterval(fetch, running ? 5_000 : 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, running, getSandboxStatus]);

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        padding: "16px 20px 32px",
        color: "var(--dsw-alias-label-primary)",
      }}
    >
      <div style={{ maxWidth: 720 }}>
        <header
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>Sandbox</h2>
          {fetchedAt !== undefined && (
            <span style={{ fontSize: 12, color: captionColor }}>
              updated {new Date(fetchedAt).toLocaleTimeString()}
            </span>
          )}
        </header>

        {error !== undefined && (
          <p
            style={{
              margin: "0 0 12px",
              color: "var(--dsw-alias-label-error)",
            }}
          >
            {error}
          </p>
        )}

        {view?.sandbox === undefined ? (
          <p style={{ margin: 0, color: captionColor }}>
            This session has no sandbox yet. It is provisioned when you send the
            first prompt.
          </p>
        ) : (
          <SandboxFacts sandbox={view.sandbox} live={view.live} />
        )}
      </div>
    </div>
  );
}

function SandboxFacts({
  sandbox,
  live,
}: {
  sandbox: SandboxHostFacts;
  live: SandboxLiveFacts | undefined;
}) {
  const { state } = sandbox;
  return (
    <>
      <Section title="Lifecycle">
        <Row label="State">
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <StateDot state={stateDot(state)} />
            {stateText(state)}
          </span>
        </Row>
        <Row label="Backend">{sandbox.backend}</Row>
        <Row label="Profile">{sandbox.profile}</Row>
        {sandbox.image !== undefined && (
          <Row label="Image">{sandbox.image}</Row>
        )}
        {sandbox.sandboxId !== undefined && (
          <Row label="Sandbox ID">{sandbox.sandboxId}</Row>
        )}
        <Row label="Started">
          {new Date(sandbox.startedAt).toLocaleString()}
        </Row>
        {sandbox.expiresAt !== undefined && (
          <Row label="Expires">
            {new Date(sandbox.expiresAt).toLocaleString()}
          </Row>
        )}
      </Section>

      <Section title="Machine">
        {live === undefined ? (
          <p style={{ margin: 0, color: captionColor }}>
            {state === "running"
              ? "Waiting for the sandbox to report in."
              : "The sandbox is not running, so it cannot report. Everything above comes from the control plane."}
          </p>
        ) : (
          <>
            <Row label="Hostname">{live.hostname}</Row>
            <Row label="System">
              {[live.osName, live.kernelVersion, live.architecture]
                .filter((part) => part !== "")
                .join(" · ")}
            </Row>
            <Row label="CPU">{live.cpuCount} cores</Row>
            <Row label="Memory">{fileSizeText(live.memoryTotalBytes)}</Row>
            <Row label="Uptime">{uptimeText(live.uptimeSeconds)}</Row>
            <Row label="Workspace disk">
              {diskText(
                live.workspaceDiskUsedBytes,
                live.workspaceDiskTotalBytes,
              )}
            </Row>
            <Row label="Filesystem">
              {diskText(
                live.filesystemDiskUsedBytes,
                live.filesystemDiskTotalBytes,
              )}
            </Row>
          </>
        )}
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3
        style={{
          margin: "0 0 6px",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: ".04em",
          textTransform: "uppercase",
          color: captionColor,
        }}
      >
        {title}
      </h3>
      <div>{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr",
        gap: 12,
        padding: "4px 0",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--dsw-alias-label-secondary)" }}>{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

const captionColor = "var(--dsw-alias-label-caption)";

function stateDot(state: SandboxHostFacts["state"]): StateDotState {
  return state === "running" ? "ongoing" : "idle";
}

function stateText(state: SandboxHostFacts["state"]): string {
  switch (state) {
    case "running":
      return "Running";
    case "hibernated":
      return "Hibernated";
    case "checkpointed":
      return "Checkpointed";
  }
}

function diskText(used: number, total: number): string {
  if (total <= 0) {
    return "unavailable";
  }
  const percent = Math.round((used / total) * 100);
  return `${fileSizeText(used)} of ${fileSizeText(total)} used (${percent}%)`;
}

function uptimeText(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
