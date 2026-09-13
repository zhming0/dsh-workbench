import type { Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it } from "vitest";

import { rootSessionId } from "../src/manager/root-session.js";

interface Header {
  parentSession?: string;
  origin?: string;
}

function agent(id: string, header: Header = {}): Agent {
  return { id, session: { header } } as unknown as Agent;
}

function subagent(id: string, parentId: string): Agent {
  return agent(id, { parentSession: parentId, origin: "subagent" });
}

/** A Fork child: dsh records the source in `parentSession`, never `origin`. */
function forkChild(id: string, sourceId: string): Agent {
  return agent(id, { parentSession: sourceId });
}

describe("rootSessionId", () => {
  it("answers the agent itself for a top-level session", () => {
    expect(rootSessionId(agent("session-one"), () => undefined)).toBe(
      "session-one",
    );
  });

  it("walks the parent chain to the top-level session", () => {
    const root = agent("root");
    const child = subagent("child", "root");
    const grandchild = subagent("grandchild", "child");
    const lookup = (id: string) => ({ root, child, grandchild })[id as "root"];

    expect(rootSessionId(child, lookup)).toBe("root");
    expect(rootSessionId(grandchild, lookup)).toBe("root");
    expect(rootSessionId(root, lookup)).toBe("root");
  });

  it("answers the agent itself when the parent is absent", () => {
    // Only the direct parent matters: an unresolvable link ends the walk
    // even when other sessions resolve.
    const grandparent = agent("grandparent");
    const child = subagent("child", "absent-parent");
    const lookup = (id: string) =>
      id === "grandparent" ? grandparent : undefined;

    expect(rootSessionId(child, lookup)).toBe("child");
  });

  it("stops at a lineage cycle instead of looping", () => {
    const a = subagent("a", "b");
    const b = subagent("b", "a");
    const lookup = (id: string) => ({ a, b })[id as "a"];

    // A cycle is unrepresentable in real dsh lineage (depth grows strictly);
    // the guard only has to terminate, at any member of the cycle.
    expect(["a", "b"]).toContain(rootSessionId(a, lookup));
    expect(["a", "b"]).toContain(rootSessionId(b, lookup));
  });

  it("does not share a sandbox with a non-subagent parent", () => {
    // Fork lineage alone must not route work onto the source's sandbox.
    const source = agent("session-source");
    const child = forkChild("session-fork", "session-source");
    const lookup = (id: string) =>
      id === "session-source" ? source : undefined;

    expect(rootSessionId(child, lookup)).toBe("session-fork");
  });
});
