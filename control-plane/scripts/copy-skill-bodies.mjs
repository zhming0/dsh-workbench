#!/usr/bin/env node

/**
 * Copy the authored skill files into the control-plane build output.
 *
 * `tsc` emits only JavaScript and declarations from `src/`, so each skill's
 * `SKILL.md`, which `skillMarkdown()` reads from beside its compiled module,
 * would be missing from `dist` and from the packaged tarball. This copies
 * every `.md` under `src/skills/` to the matching path under `dist/skills/`,
 * keeping each skill's folder.
 *
 * It lives inside the package because `prepack` runs it, including in the
 * control-plane image build, whose context carries `control-plane/` but not
 * the repository's own `scripts/`. Paths resolve from this file, not the
 * working directory, so it works from either.
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

/** Every `.md` under `directory`, as a path relative to `source`. */
async function skillBodies(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  const found = [];
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await skillBodies(join(directory, entry.name), path)));
    } else if (entry.name.endsWith(".md")) {
      found.push(path);
    }
  }
  return found;
}

const files = await skillBodies(source);
for (const file of files) {
  const target = join(destination, file);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(source, file), target);
}

process.stdout.write(`copied ${files.length} skill file(s)\n`);
