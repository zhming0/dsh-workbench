#!/usr/bin/env node

/**
 * Copy the authored skill bodies into the provider build output.
 *
 * `tsc` emits only JavaScript and declarations from `src/`, so a skill's
 * Markdown body — which `skillMarkdown()` reads from beside its compiled
 * module — would be missing from `dist` and from the packaged tarball. This
 * copies every `src/skills/*.md` to the matching `dist/skills/` path.
 *
 * It lives inside the package because `prepack` runs it, including in the host
 * image build, whose context carries `provider/` but not the repository's own
 * `scripts/`. Paths resolve from this file, not the working directory, so it
 * works from either.
 *
 * A skill module with no body is not an error here: the module itself fails
 * at load when it cannot read its file, naming the path, which is the report
 * a maintainer needs.
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "src", "skills");
const destination = join(packageRoot, "dist", "skills");

const names = await readdir(source).catch((error) => {
  if (error.code === "ENOENT") {
    return [];
  }
  throw error;
});
const bodies = names.filter((name) => name.endsWith(".md"));

if (bodies.length > 0) {
  await mkdir(destination, { recursive: true });
  for (const name of bodies) {
    await cp(join(source, name), join(destination, name));
  }
}

process.stdout.write(`copied ${bodies.length} skill body file(s)\n`);
