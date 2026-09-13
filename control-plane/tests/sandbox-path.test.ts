import { describe, expect, it } from "vitest";

import { pathInSandbox } from "../src/sandbox-path.js";

describe("sandbox path mapping", () => {
  it("maps dsh workspace paths into the sandbox workspace", () => {
    const sessionWorkspace = "/home/user/project";
    const sandboxWorkspace = "/workspace/repository";

    expect(
      pathInSandbox(sessionWorkspace, sessionWorkspace, sandboxWorkspace),
    ).toBe("/workspace/repository");
    expect(
      pathInSandbox(
        "/home/user/project/packages/api",
        sessionWorkspace,
        sandboxWorkspace,
      ),
    ).toBe("/workspace/repository/packages/api");
    expect(
      pathInSandbox(
        "/workspace/repository/packages/web",
        sessionWorkspace,
        sandboxWorkspace,
      ),
    ).toBe("/workspace/repository/packages/web");
    expect(
      pathInSandbox(
        "/home/user/another-project",
        sessionWorkspace,
        sandboxWorkspace,
      ),
    ).toBe("/home/user/another-project");
    expect(
      pathInSandbox(
        "/home/user/project/../outside",
        sessionWorkspace,
        sandboxWorkspace,
      ),
    ).toBe("/home/user/project/../outside");
    expect(
      pathInSandbox("packages/worker", sessionWorkspace, sandboxWorkspace),
    ).toBe("packages/worker");
  });
});
