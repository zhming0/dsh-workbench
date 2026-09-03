/** Mint a v4 UUID without the secure-context-only randomUUID API. */
export function fallbackRandomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte, index) => {
    const pinned =
      index === 6
        ? (byte & 0x0f) | 0x40
        : index === 8
          ? (byte & 0x3f) | 0x80
          : byte;
    return pinned.toString(16).padStart(2, "0");
  }).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * dsh 0.1.1-rc.2 calls crypto.randomUUID in browser code, but browsers omit
 * that method on plain-HTTP LAN origins. Remove this shim after upgrading to a
 * dsh release containing deepseek-harness commit 0bee546.
 */
export function installRandomUUIDFallback(): void {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return;
  }
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: fallbackRandomUUID,
    configurable: true,
    writable: true,
  });
}

installRandomUUIDFallback();
