import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunnerClient } from "./runner-client.js";

/**
 * Where a session's work went when its sandbox could not be kept. A backend
 * without hibernation (Buildkite) loses the whole machine on idle, so the
 * manager commits the working tree inside the sandbox, pulls the commits the
 * repository's remote does not have out as a git bundle, keeps that bundle on
 * the host, and unpacks it into the next sandbox.
 */
export interface Checkpoint {
  /** HEAD when the sandbox was released, after the checkpoint commit if any. */
  commit: string;
  /** Branch the session had checked out, absent when HEAD was detached. */
  branch?: string;
}

/**
 * A bundle bigger than this fails the checkpoint and keeps the sandbox up. A
 * bundle holds only the commits the remote lacks, so ordinary sessions stay
 * far below it; the cap bounds host memory and disk for the pathological one.
 */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const COMMIT_MESSAGE = "dsh: checkpoint before the sandbox is released";

/**
 * Shared by both scripts: is HEAD the commit the save script makes? Matching
 * the fixed author and subject means the restore only ever undoes its own
 * commit, and a save retried after a failure does not stack a second one.
 */
const IS_CHECKPOINT_COMMIT = `is_checkpoint_commit() {
  [ "$(git log -1 --format='%ae %s' 2>/dev/null)" = "dsh@localhost ${COMMIT_MESSAGE}" ]
}`;

/**
 * Runs in the sandbox before it is released. Prints two lines, the current
 * branch (empty when detached) and the resulting HEAD, followed by the bundle
 * bytes. The bundle carries every commit between HEAD and its merge base with
 * the remote's default branch, which a fresh clone always has; it is empty
 * when HEAD is already on the remote. Without a usable `origin/HEAD` the
 * bundle is self-contained. The identity is fixed because the runner image
 * configures none.
 */
export const SAVE_SCRIPT = `set -eu
${IS_CHECKPOINT_COMMIT}
branch=$(git symbolic-ref --quiet --short HEAD || true)
if is_checkpoint_commit; then
  git reset -q HEAD~1
fi
git add --all
if ! git diff --cached --quiet; then
  git -c user.name=dsh -c user.email=dsh@localhost commit -q -m "${COMMIT_MESSAGE}"
fi
head=$(git rev-parse HEAD)
base=$(git merge-base HEAD origin/HEAD 2>/dev/null || true)
printf '%s\\n%s\\n' "$branch" "$head"
if [ -z "$base" ]; then
  git bundle create -q - HEAD
elif [ "$base" != "$head" ]; then
  git bundle create -q - "$base..HEAD"
fi
`;

/**
 * Runs in the new sandbox after setup, with the bundle on stdin. Unpacks the
 * commits, puts the session back on its own branch (or a detached HEAD) at
 * the checkpoint, and turns the checkpoint commit back into uncommitted
 * changes. A commit the bundle did not bring and the clone does not have
 * stops the script before it moves anything.
 */
export const RESTORE_SCRIPT = `set -eu
${IS_CHECKPOINT_COMMIT}
if [ "$DSH_CHECKPOINT_HAS_BUNDLE" = 1 ]; then
  git bundle unbundle - >/dev/null
fi
git cat-file -e "$DSH_CHECKPOINT_COMMIT^{commit}"
if [ -n "$DSH_CHECKPOINT_BRANCH" ]; then
  git checkout -q -B "$DSH_CHECKPOINT_BRANCH" "$DSH_CHECKPOINT_COMMIT"
  git branch -q --set-upstream-to="origin/$DSH_CHECKPOINT_BRANCH" 2>/dev/null || true
else
  git checkout -q --detach "$DSH_CHECKPOINT_COMMIT"
fi
if is_checkpoint_commit; then
  git reset -q HEAD~1
fi
`;

export interface SavedCheckpoint {
  checkpoint: Checkpoint;
  /** Git bundle bytes; empty when the remote already has the commit. */
  bundle: Uint8Array;
}

const BUNDLE_HEADER = /^# v\d+ git bundle\n/;

export function parseSaveOutput(output: Uint8Array): SavedCheckpoint {
  const buffer = Buffer.from(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  const first = buffer.indexOf("\n");
  const second = first === -1 ? -1 : buffer.indexOf("\n", first + 1);
  const branch = second === -1 ? "" : buffer.subarray(0, first).toString();
  const commit =
    second === -1 ? "" : buffer.subarray(first + 1, second).toString();
  const bundle = second === -1 ? buffer : buffer.subarray(second + 1);
  if (
    !/^[0-9a-f]{40}$/.test(commit) ||
    (bundle.length > 0 &&
      !BUNDLE_HEADER.test(bundle.subarray(0, 32).toString("latin1")))
  ) {
    throw new Error(
      `unexpected checkpoint output: ${JSON.stringify(buffer.subarray(0, 120).toString("latin1"))}`,
    );
  }
  return {
    checkpoint: { commit, ...(branch === "" ? {} : { branch }) },
    bundle,
  };
}

export function restoreEnvironment(
  checkpoint: Checkpoint,
  bundle: Uint8Array,
): Record<string, string> {
  return {
    DSH_CHECKPOINT_COMMIT: checkpoint.commit,
    DSH_CHECKPOINT_BRANCH: checkpoint.branch ?? "",
    DSH_CHECKPOINT_HAS_BUNDLE: bundle.length > 0 ? "1" : "0",
  };
}

/** Commit the session's working tree in the still-running sandbox and pull the bundle out. */
export async function saveCheckpoint(
  client: RunnerClient,
  workspace: string,
): Promise<SavedCheckpoint> {
  const output = await runScript(client, workspace, SAVE_SCRIPT, {
    env: {},
    stdin: new Uint8Array(),
    stdoutMaxBytes: MAX_BUNDLE_BYTES,
  });
  return parseSaveOutput(output);
}

/** Turn a fresh clone back into the session's tree. */
export async function restoreCheckpoint(
  client: RunnerClient,
  workspace: string,
  checkpoint: Checkpoint,
  bundle: Uint8Array,
): Promise<void> {
  await runScript(client, workspace, RESTORE_SCRIPT, {
    env: restoreEnvironment(checkpoint, bundle),
    stdin: bundle,
    stdoutMaxBytes: 4096,
  });
}

/**
 * One bundle file per checkpointed session, next to the file index in the
 * host's state directory. Same trust domain as a hibernated sandbox's disk:
 * whatever the working tree held, ignored files aside, is in here.
 */
export class CheckpointStore {
  constructor(private readonly directory: string) {}

  async save(sessionId: string, bundle: Uint8Array): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(sessionId);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, bundle, { mode: 0o600 });
    await rename(temporary, path);
  }

  async load(sessionId: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.pathFor(sessionId));
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.pathFor(sessionId), { force: true });
  }

  private pathFor(sessionId: string): string {
    return join(this.directory, `${encodeURIComponent(sessionId)}.bundle`);
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Run a bash script in the workspace and return its stdout. Plain `bash -c`,
 * not a login shell: profile output would land in the parsed stdout.
 */
async function runScript(
  client: RunnerClient,
  workspace: string,
  script: string,
  options: {
    env: Record<string, string>;
    stdin: Uint8Array;
    stdoutMaxBytes: number;
  },
): Promise<Uint8Array> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let stdoutBytes = 0;
  let exited = false;
  const stream = client.exec({
    argv: ["/bin/bash", "-c", script],
    cwd: workspace,
    env: options.env,
    stdin: options.stdin,
  });
  for await (const { event } of stream) {
    if (event.case === "stdout") {
      stdoutBytes += event.value.byteLength;
      if (stdoutBytes > options.stdoutMaxBytes) {
        throw new Error(
          `checkpoint script output exceeds ${options.stdoutMaxBytes} bytes`,
        );
      }
      stdout.push(event.value);
    } else if (event.case === "stderr") {
      stderr.push(event.value);
    } else if (event.case === "exited") {
      exited = true;
      if (event.value.exitCode !== 0) {
        throw new Error(
          `checkpoint script failed with exit code ${event.value.exitCode}: ${Buffer.concat(stderr).toString().trim()}`,
        );
      }
    }
  }
  if (!exited) {
    throw new Error("checkpoint script ended without an exit status");
  }
  return Buffer.concat(stdout);
}
