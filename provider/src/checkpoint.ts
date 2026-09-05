import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { RunnerClient } from "./runner-client.js";

const execute = promisify(execFile);

/**
 * Where a session's work went when its sandbox could not be kept. A backend
 * without hibernation (Buildkite) loses the whole machine on idle, so the
 * manager pushes the working tree to a branch on the repository's remote and
 * checks it out again in the next sandbox.
 */
export interface Checkpoint {
  /** Branch on `origin` holding the pushed tree, without `refs/heads/`. */
  ref: string;
  /** The commit that was pushed; the restore refuses to undo anything else. */
  commit: string;
  /** Branch the session had checked out, absent when HEAD was detached. */
  branch?: string;
  /** True when the tree had changes and a checkpoint commit was added on top. */
  committed: boolean;
}

/** One branch per session; a later checkpoint force-pushes over the earlier. */
export function checkpointRef(sessionId: string): string {
  const hash = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return `dsh/wip/${hash}`;
}

/**
 * Untracked files that are never checkpointed. Unlike hibernation, a
 * checkpoint leaves the sandbox and lands on the repository's real remote, so
 * a credentials file the model wrote without ignoring it would become
 * readable by anyone who can list branches. Tracked files are not filtered:
 * they are already on the remote. Pathspecs in `git` glob syntax, matched at
 * any depth.
 */
export const EXCLUDED_UNTRACKED = [
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/id_rsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/.netrc",
  "**/.git-credentials",
  "**/credentials.json",
];

const excludePathspecs = EXCLUDED_UNTRACKED.map(
  (pattern) => `':(exclude,glob)${pattern}'`,
).join(" ");

/**
 * Runs in the sandbox before it is released. Prints three lines: the current
 * branch (empty when detached), whether a checkpoint commit was made, and the
 * commit that was pushed. The identity is fixed because the runner image
 * configures none.
 */
export const SAVE_SCRIPT = `set -eu
branch=$(git symbolic-ref --quiet --short HEAD || true)
git add --update
git add --all -- . ${excludePathspecs}
if git diff --cached --quiet; then
  committed=0
else
  git -c user.name=dsh -c user.email=dsh@localhost commit -q -m "dsh: checkpoint before the sandbox is released"
  committed=1
fi
git push --force --quiet origin "HEAD:refs/heads/$DSH_CHECKPOINT_REF"
printf '%s\\n%s\\n%s\\n' "$branch" "$committed" "$(git rev-parse HEAD)"
`;

/**
 * Runs in the new sandbox after the checkpoint branch was cloned and checked
 * out. Puts the session back on its own branch (or a detached HEAD), turns the
 * checkpoint commit back into uncommitted changes, and removes the checkpoint
 * branch locally and on the remote. Deleting the remote branch is best effort;
 * the next checkpoint force-pushes over it anyway.
 *
 * The script only ever undoes the commit it made: when HEAD is anything else
 * it stops rather than reset unrelated history.
 */
export const RESTORE_SCRIPT = `set -eu
head=$(git rev-parse HEAD)
if [ "$head" != "$DSH_CHECKPOINT_COMMIT" ]; then
  echo "workspace is at $head, not at checkpoint $DSH_CHECKPOINT_COMMIT" >&2
  exit 1
fi
if [ -n "$DSH_CHECKPOINT_BRANCH" ]; then
  git checkout -q -B "$DSH_CHECKPOINT_BRANCH"
  git branch -q --set-upstream-to="origin/$DSH_CHECKPOINT_BRANCH" 2>/dev/null || true
else
  git checkout -q --detach
fi
if [ "$DSH_CHECKPOINT_COMMITTED" = 1 ]; then
  git reset -q HEAD~1
fi
git branch -q -D "$DSH_CHECKPOINT_REF"
git push --quiet origin --delete "refs/heads/$DSH_CHECKPOINT_REF" || true
`;

export function parseSaveOutput(ref: string, output: string): Checkpoint {
  const [branch = "", committed = "", commit = ""] = output.split("\n");
  if (
    (committed !== "0" && committed !== "1") ||
    !/^[0-9a-f]{40}$/.test(commit)
  ) {
    throw new Error(`unexpected checkpoint output: ${JSON.stringify(output)}`);
  }
  return {
    ref,
    commit,
    ...(branch === "" ? {} : { branch }),
    committed: committed === "1",
  };
}

export function restoreEnvironment(
  checkpoint: Checkpoint,
): Record<string, string> {
  return {
    DSH_CHECKPOINT_REF: checkpoint.ref,
    DSH_CHECKPOINT_COMMIT: checkpoint.commit,
    DSH_CHECKPOINT_BRANCH: checkpoint.branch ?? "",
    DSH_CHECKPOINT_COMMITTED: checkpoint.committed ? "1" : "0",
  };
}

/** Push the session's working tree from the still-running sandbox. */
export async function saveCheckpoint(
  client: RunnerClient,
  workspace: string,
  sessionId: string,
): Promise<Checkpoint> {
  const ref = checkpointRef(sessionId);
  const output = await runScript(client, workspace, SAVE_SCRIPT, {
    DSH_CHECKPOINT_REF: ref,
  });
  return parseSaveOutput(ref, output);
}

/** Turn a freshly cloned checkpoint branch back into the session's tree. */
export async function restoreCheckpoint(
  client: RunnerClient,
  workspace: string,
  checkpoint: Checkpoint,
): Promise<void> {
  await runScript(
    client,
    workspace,
    RESTORE_SCRIPT,
    restoreEnvironment(checkpoint),
  );
}

/**
 * Delete a checkpoint branch from the host, for a session that ended without
 * a sandbox to do it from. `git push` needs a repository to run in, so an
 * empty one is created for the call. The credential reaches git through the
 * child's environment, not its command line, so it never shows in a process
 * listing.
 */
export async function deleteCheckpointBranch(
  repositoryUrl: string,
  ref: string,
  credential: { username: string; password: string } | undefined,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "dsh-checkpoint-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const config: string[] = [];
    if (credential !== undefined) {
      env["DSH_GIT_USERNAME"] = credential.username;
      env["DSH_GIT_PASSWORD"] = credential.password;
      config.push(
        "-c",
        "credential.helper=",
        "-c",
        'credential.helper=!f() { echo "username=$DSH_GIT_USERNAME"; echo "password=$DSH_GIT_PASSWORD"; }; f',
      );
    }
    await execute("git", ["init", "-q"], { cwd: scratch });
    await execute(
      "git",
      [
        ...config,
        "push",
        "--quiet",
        repositoryUrl,
        "--delete",
        `refs/heads/${ref}`,
      ],
      { cwd: scratch, env, timeout: 30_000 },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Run a bash script in the workspace and return its stdout. Plain `bash -c`,
 * not a login shell: profile output would land in the parsed stdout.
 */
async function runScript(
  client: RunnerClient,
  workspace: string,
  script: string,
  env: Record<string, string>,
): Promise<string> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let exited = false;
  const stream = client.exec({
    argv: ["/bin/bash", "-c", script],
    cwd: workspace,
    env,
    stdin: new Uint8Array(),
  });
  for await (const { event } of stream) {
    if (event.case === "stdout") {
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
  return Buffer.concat(stdout).toString();
}
