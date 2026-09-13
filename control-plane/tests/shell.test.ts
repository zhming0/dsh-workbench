import { describe, expect, it } from "vitest";

import { testing as shellTesting } from "../src/shell.js";

describe("shell output buffers", () => {
  it("keeps a bounded output tail and reports truncation", () => {
    const shell = new shellTesting.TailBuffer(4);
    shell.append(new TextEncoder().encode("abcdef"));
    expect(shell.collected()).toEqual({ text: "cdef", truncated: true });
  });
});
