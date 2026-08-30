import { webcrypto } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fallbackRandomUUID,
  installRandomUUIDFallback,
} from "../src/client/crypto-compat.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("browser crypto compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("installs a v4 randomUUID on the insecure-origin crypto shape", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });

    installRandomUUIDFallback();

    expect(crypto.randomUUID()).toMatch(UUID_V4);
    expect(fallbackRandomUUID()).toMatch(UUID_V4);
  });

  it("keeps the platform implementation when one exists", () => {
    const randomUUID = vi.fn(() => "platform-uuid");
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      randomUUID,
    });

    installRandomUUIDFallback();

    expect(crypto.randomUUID()).toBe("platform-uuid");
    expect(randomUUID).toHaveBeenCalledOnce();
  });
});
