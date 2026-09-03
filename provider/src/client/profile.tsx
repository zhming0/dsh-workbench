import { useEffect, useState } from "react";

import {
  Menu,
  IconChevronDownOutline14,
} from "@deepseek-ai/dsh-client-ui-primitives";
// Type-only imports for the declaration merges that define the
// `conversation.input.left` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type { SessionProfileView } from "../session-profile-remote.js";

export interface SessionProfileActions {
  getSessionProfile: (sessionId: string) => Promise<SessionProfileView>;
  setSessionProfile: (
    sessionId: string,
    profile: string,
  ) => Promise<SessionProfileView>;
}

type SandboxProfileChipProps = PropsRuntime<"conversation.input.left"> &
  SessionProfileActions;

/**
 * Composer tool-row chip that picks the sandbox profile for a session before
 * its first prompt provisions a sandbox. Hidden when the host offers a single
 * profile, so a plain install looks unchanged.
 */
export function SandboxProfileChip({
  sessionId: id,
  useSession,
  getSessionProfile,
  setSessionProfile,
}: SandboxProfileChipProps) {
  const sessionId = String(id);
  const blank = useSession((s) => s.blank);
  const running = useSession((s) => s.running);
  const [view, setView] = useState<SessionProfileView>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hovered, setHovered] = useState(false);

  // `blank` flips when the first prompt is sent and `running` flips back when
  // its turn ends; the sandbox is provisioned in between, so the second fetch
  // is the one that sees the choice locked.
  useEffect(() => {
    let cancelled = false;
    getSessionProfile(sessionId)
      .then((next) => {
        if (!cancelled) {
          setView(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setView(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, blank, running, getSessionProfile]);

  if (view === undefined || view.profiles.length < 2) {
    return null;
  }

  const choose = (profile: string) => {
    setOpen(false);
    if (profile === view.selected) {
      return;
    }
    setBusy(true);
    setSessionProfile(sessionId, profile)
      .then(setView)
      .catch(() => getSessionProfile(sessionId).then(setView, () => {}))
      .finally(() => setBusy(false));
  };

  // A running turn may be provisioning right now; do not race it.
  const disabled = view.locked || running || busy;
  return (
    <Menu
      open={open}
      side="top"
      items={view.profiles.map(({ name, backend }) => ({
        id: name,
        label: (
          <>
            {name}
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                color: "var(--dsw-alias-label-caption)",
              }}
            >
              {backend}
            </span>
          </>
        ),
      }))}
      selectedId={view.selected}
      onSelect={choose}
      onClose={() => setOpen(false)}
      anchor={
        <button
          type="button"
          data-testid="dsh-workbench-profile"
          aria-label={`Sandbox profile: ${view.selected}`}
          title={
            view.locked
              ? "This session already has a sandbox"
              : "Sandbox profile for this session"
          }
          disabled={disabled}
          onClick={() => setOpen(!open)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 28,
            minWidth: 0,
            maxWidth: 220,
            padding: "0 4px 0 8px",
            background: hovered && !disabled ? hoverBackground : "none",
            border: "none",
            borderRadius: 24,
            color: disabled ? "var(--dsw-alias-label-dimmed)" : labelColor,
            cursor: disabled ? "default" : "pointer",
            font: "inherit",
            fontSize: 13,
            fontWeight: 500,
            lineHeight: "20px",
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <SandboxIcon />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {view.selected}
          </span>
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              color: "var(--dsw-alias-label-caption)",
              transition: "transform .12s",
              transform: open ? "rotate(180deg)" : undefined,
            }}
          >
            <IconChevronDownOutline14 />
          </span>
        </button>
      }
    />
  );
}

const labelColor = "var(--dsw-alias-label-secondary)";
const hoverBackground = "var(--dsw-alias-interactive-bg-hover)";

/** A box glyph in the 16px outline style of dsh's own chip icons; the
 * primitives package ships nothing that reads as a sandbox. */
function SandboxIcon() {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <path d="M8 1.75 14 4.75v6.5L8 14.25 2 11.25v-6.5L8 1.75Z" />
      <path d="M2 4.75 8 7.75l6-3M8 7.75v6.5" />
    </svg>
  );
}
