import { describe, expect, it } from "vitest";

import { sandboxBoundaryText } from "../src/sandbox-context.js";

const WORKSPACE = "/workspace/repository";
const ANCHOR =
  "/data/.dsh-sandbox/workspace-anchors/github-com-zhming0-dsh-workbench-abc";

describe("sandbox boundary context", () => {
  it("names the sandbox-visible workspace and the host-side path", () => {
    const text = sandboxBoundaryText(WORKSPACE, ANCHOR);
    expect(text).toContain(WORKSPACE);
    expect(text).toContain(ANCHOR);
    expect(text).toContain("does not exist inside the container");
    expect(text).toContain("container is the boundary");
    expect(text).toContain("host file sandbox, which this profile disables");
  });

  it("omits the host-side sentence when there is no session cwd", () => {
    const text = sandboxBoundaryText(WORKSPACE, undefined);
    expect(text).toContain(WORKSPACE);
    expect(text).not.toContain("host-side path");
    expect(text).not.toContain("does not exist inside the container");
  });
});
