import { createHash } from "node:crypto";

/**
 * Where a session's work went when its sandbox could not be kept. A backend
 * without hibernation (Buildkite) loses the whole machine on idle, so the
 * manager pushes the working tree to a branch on the repository's remote and
 * checks it out again in the next sandbox.
 */
export interface Checkpoint {
  /** Branch on `origin` holding the pushed tree, without `refs/heads/`. */
  ref: string;
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
 * Runs in the sandbox before it is released. Prints two lines: the current
 * branch (empty when detached) and whether a checkpoint commit was made.
 * The identity is fixed because the runner image configures none.
 */
export const SAVE_SCRIPT = `set -eu
branch=$(git symbolic-ref --quiet --short HEAD || true)
git add -A
if git diff --cached --quiet; then
  committed=0
else
  git -c user.name=dsh -c user.email=dsh@localhost commit -q -m "dsh: checkpoint before the sandbox is released"
  committed=1
fi
git push --force --quiet origin "HEAD:refs/heads/$DSH_CHECKPOINT_REF"
printf '%s\\n%s\\n' "$branch" "$committed"
`;

/**
 * Runs in the new sandbox after the checkpoint branch was cloned and checked
 * out. Puts the session back on its own branch (or a detached HEAD), turns the
 * checkpoint commit back into uncommitted changes, and removes the checkpoint
 * branch locally and on the remote. Deleting the remote branch is best effort;
 * the next checkpoint force-pushes over it anyway.
 */
export const RESTORE_SCRIPT = `set -eu
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
  const [branch = "", committed = ""] = output.split("\n");
  if (committed !== "0" && committed !== "1") {
    throw new Error(`unexpected checkpoint output: ${JSON.stringify(output)}`);
  }
  return {
    ref,
    ...(branch === "" ? {} : { branch }),
    committed: committed === "1",
  };
}

export function restoreEnvironment(
  checkpoint: Checkpoint,
): Record<string, string> {
  return {
    DSH_CHECKPOINT_REF: checkpoint.ref,
    DSH_CHECKPOINT_BRANCH: checkpoint.branch ?? "",
    DSH_CHECKPOINT_COMMITTED: checkpoint.committed ? "1" : "0",
  };
}
