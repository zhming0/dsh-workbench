import type { Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it } from "vitest";

import { rootSessionId } from "../src/manager/root-session.js";

function agent(id: string, parentSession?: string): Agent {
  return {
    id,
    session: {
      header: parentSession === undefined ? {} : { parentSession },
    },
  } as unknown as Agent;
}

describe("rootSessionId", () => {
  it("answers the agent itself for a top-level session", () => {
    expect(rootSessionId(agent("session-one"), () => undefined)).toBe(
      "session-one",
    );
  });

  it("walks the parent chain to the top-level session", () => {
    const root = agent("root");
    const child = agent("child", "root");
    const grandchild = agent("grandchild", "child");
    const lookup = (id: string) => ({ root, child, grandchild })[id as "root"];

    expect(rootSessionId(child, lookup)).toBe("root");
    expect(rootSessionId(grandchild, lookup)).toBe("root");
    expect(rootSessionId(root, lookup)).toBe("root");
  });

  it("answers the agent itself when the parent is absent", () => {
    // Only the direct parent matters: an unresolvable link ends the walk
    // even when other sessions resolve.
    const grandparent = agent("grandparent");
    const child = agent("child", "absent-parent");
    const lookup = (id: string) =>
      id === "grandparent" ? grandparent : undefined;

    expect(rootSessionId(child, lookup)).toBe("child");
  });

  it("stops at a lineage cycle instead of looping", () => {
    const a = agent("a", "b");
    const b = agent("b", "a");
    const lookup = (id: string) => ({ a, b })[id as "a"];

    // A cycle is unrepresentable in real dsh lineage (depth grows strictly);
    // the guard only has to terminate, at any member of the cycle.
    expect(["a", "b"]).toContain(rootSessionId(a, lookup));
    expect(["a", "b"]).toContain(rootSessionId(b, lookup));
  });
});
