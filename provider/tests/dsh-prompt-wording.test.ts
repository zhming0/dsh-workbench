import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { isHostOnlySection } from "../src/sandbox-context.js";
import {
  HARNESS_SOURCE_TEMPLATE,
  WEB_SURFACE_TEMPLATE,
} from "./observed-prompt.js";

const run = promisify(execFile);

/**
 * The packages that compose the host-only prompt paragraphs. Verified at
 * 0.1.2-rc.1: addHarnessSourceSection in dsh-app-boot writes the checkout
 * paragraph, webSurfacePrompt in dsh-web-app writes the GUI paragraph. If a
 * later dsh moves the composition elsewhere, this list is what to update.
 */
const COMPOSER_PACKAGES = [
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-web-app",
];

/**
 * The dsh version this provider is pinned to. dsh-version.test keeps every
 * `@deepseek-ai/dsh-*` pin equal, so one pin stands for the release; a bump
 * therefore re-runs this test against the new version's own wording.
 */
async function pinnedDshVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;
  const version = manifest.devDependencies?.["@deepseek-ai/dsh-agent"];
  if (version === undefined) {
    throw new Error("provider does not pin @deepseek-ai/dsh-agent");
  }
  return version.replace(/^\^/, "");
}

/**
 * Download one composer package at the pinned version and return the
 * concatenated text of every file it ships. Requires registry access; that
 * is the point — this test is the tripwire that makes a dsh rewording of the
 * paragraphs fail CI in the same change that bumps the pin.
 */
async function downloadPackageTexts(
  name: string,
  version: string,
  dir: string,
): Promise<string> {
  await run("npm", ["pack", `${name}@${version}`, "--pack-destination", dir], {
    cwd: dir,
  });
  const tarball = join(
    dir,
    `${name.replaceAll("@", "").replaceAll("/", "-")}-${version}.tgz`,
  );
  const extracted = join(dir, name.replaceAll("/", "-"));
  await mkdir(extracted, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", extracted]);
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        files.push(path);
      }
    }
  }
  await walk(extracted);
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return texts.join("\n");
}

it("the pinned dsh packages still compose the paragraphs our markers target", async () => {
  const version = await pinnedDshVersion();
  const dir = await mkdtemp(join(tmpdir(), "dsh-prompt-wording-"));
  try {
    let corpus = "";
    for (const name of COMPOSER_PACKAGES) {
      corpus += await downloadPackageTexts(name, version, dir);
    }
    const paragraphs = [
      {
        package: "@deepseek-ai/dsh-app-boot",
        template: HARNESS_SOURCE_TEMPLATE,
        fills: { sourceRoot: "https://example.invalid/dsh" },
      },
      {
        package: "@deepseek-ai/dsh-web-app",
        template: WEB_SURFACE_TEMPLATE,
        fills: { webUrl: "http://127.0.0.1:3000" },
      },
    ];
    for (const { package: pkg, template, fills } of paragraphs) {
      expect(
        corpus.includes(template),
        `dsh ${version} no longer composes this paragraph in ${pkg}: ${template} — ` +
          "read the paragraph in that package's lib/index.js, then update " +
          "HOST_ONLY_SECTION_MARKERS in src/sandbox-context.ts and the " +
          "fixtures in tests/observed-prompt.ts to match",
      ).toBe(true);
      const rendered = Object.entries(fills).reduce(
        (text, [key, value]) => text.replaceAll("${" + key + "}", value),
        template,
      );
      expect(
        isHostOnlySection(rendered),
        `the markers in src/sandbox-context.ts must cover the ${pkg} paragraph as the model sees it`,
      ).toBe(true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
