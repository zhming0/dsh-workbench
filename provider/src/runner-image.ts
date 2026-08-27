import { readFileSync } from "node:fs";

/**
 * The release pipeline publishes the runner image under the same version it
 * publishes this package, so the package version is the only source of truth
 * for which image a given provider build expects.
 */
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const RUNNER_IMAGE_REPOSITORY = "ghcr.io/zhming0/dsh-runner";

export const DEFAULT_RUNNER_IMAGE = `${RUNNER_IMAGE_REPOSITORY}:${manifest.version}`;
