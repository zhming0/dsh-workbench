import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * The host image derives the dsh launcher version from the
 * `@deepseek-ai/dsh-agent` pin, so that derivation only has one possible
 * answer when every dsh pin in this manifest agrees.
 */
it("pins every @deepseek-ai/dsh-* dependency to one version", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;

  const pins = new Map<string, string>();
  for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(manifest[group] ?? {})) {
      if (!name.startsWith("@deepseek-ai/dsh-")) {
        continue;
      }
      pins.set(`${group} > ${name}`, range.replace(/^\^/, ""));
    }
  }

  expect(pins.size).toBeGreaterThan(0);
  expect(new Set(pins.values()).size, JSON.stringify([...pins], null, 2)).toBe(
    1,
  );
});
