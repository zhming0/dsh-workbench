import type { CredentialBroker } from "../broker.js";
import { deleteCheckpointBranch } from "../checkpoint.js";
import type { SessionRecord } from "../types.js";
import type { LifecycleHooks } from "./sandbox-lifecycle.js";

export interface CheckpointHooksDependencies {
  broker: CredentialBroker;
  warn(message: string): void;
}

/**
 * Cleans up after a checkpointed session ends: the branch a checkpoint pushed
 * is normally deleted by the restore, but a session released or expired while
 * checkpointed has no sandbox to do that from, so the host deletes it. Best
 * effort: the branch is a copy of work the user gave up, not state the host
 * depends on.
 */
export class CheckpointHooks implements LifecycleHooks {
  constructor(private readonly deps: CheckpointHooksDependencies) {}

  async afterRelease(record: SessionRecord): Promise<void> {
    if (record.state !== "checkpointed") {
      return;
    }
    const { ref } = record.checkpoint;
    try {
      await this.deps.broker.refresh();
      const [credential] = await this.deps.broker.gitCredentials(
        record.repositoryUrl,
      );
      await deleteCheckpointBranch(record.repositoryUrl, ref, credential);
    } catch (error) {
      this.deps.warn(
        `could not delete checkpoint branch ${ref} of ${record.sessionId} from ${record.repositoryUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
