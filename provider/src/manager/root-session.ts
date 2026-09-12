import type { Agent } from "@deepseek-ai/dsh-agent";

/**
 * Resolve the top-level session whose sandbox serves one agent's file and
 * command work.
 *
 * Subagent sessions share their root session's sandbox, so every sandbox
 * lookup keys on the root. The child session header carries the durable
 * `parentSession` lineage, and in-process children resolve each ancestor
 * through the live agent registry. A link that cannot be resolved — an
 * absent or disposed ancestor — degrades to the agent itself, which is the
 * per-session sandbox this provider shipped before root keying.
 *
 * Only a real subagent child shares a sandbox. dsh records `parentSession`
 * for any session cut from another session's log, so a Fork child carries
 * its source in the same field; the `origin` marker separates the two. A
 * fork is a top-level session that owns a fresh working copy, so following
 * its lineage would hand it the source's sandbox — waking a hibernated
 * source and letting both sessions write one copy.
 *
 * `origin` is load-bearing here even though dsh calls it "presentation
 * metadata, not proof" in its `SessionHeader` docs: sandbox identity depends
 * on it, so it is a compatibility risk, not a display detail. If dsh renames
 * the field, drops it, or marks subagent children another way, this check
 * stops matching and every child — including forks — resolves to itself.
 * Broadening who shares a sandbox needs its own evidence; the current default
 * gives each unseen child its own, which is correct for a fork and a lost
 * shared working copy for delegation. Read the pinned package's
 * `SessionHeader` before changing this, and keep the fork case in
 * `root-session.test.ts` passing.
 */
export function rootSessionId(
  agent: Agent,
  agentLookup: (sessionId: string) => Agent | undefined,
): string {
  let current = agent;
  const seen = new Set<string>([String(current.id)]);
  for (;;) {
    const { origin, parentSession } = current.session.header;
    // Only a marked subagent child may inherit a parent's sandbox. An
    // unmarked child serves itself instead of inheriting a sandbox it may
    // not own. See the risk note above.
    if (
      origin !== "subagent" ||
      parentSession === undefined ||
      seen.has(String(parentSession))
    ) {
      return String(current.id);
    }
    const parent = agentLookup(String(parentSession));
    if (parent === undefined) {
      return String(current.id);
    }
    seen.add(String(parentSession));
    current = parent;
  }
}
