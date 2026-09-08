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
 */
export function rootSessionId(
  agent: Agent,
  agentLookup: (sessionId: string) => Agent | undefined,
): string {
  let current = agent;
  const seen = new Set<string>([String(current.id)]);
  for (;;) {
    const parentId = current.session.header.parentSession;
    if (parentId === undefined || seen.has(String(parentId))) {
      return String(current.id);
    }
    const parent = agentLookup(String(parentId));
    if (parent === undefined) {
      return String(current.id);
    }
    seen.add(String(parentId));
    current = parent;
  }
}
