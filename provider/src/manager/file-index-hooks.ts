import type { Agent } from "@deepseek-ai/dsh-agent";

import {
  captureFileIndex,
  FileIndexStore,
  type FileIndex,
  type FileIndexOptions,
} from "../file-index.js";
import type { RunnerClient } from "../runner-client.js";
import type { SessionStore } from "../state-store.js";
import type { SessionRecord } from "../types.js";
import type { LifecycleHooks } from "./sandbox-lifecycle.js";

/** What the "@" file-index feature needs from outside the lifecycle. */
export interface FileIndexHooksDependencies {
  fileIndexes: FileIndexStore;
  store: SessionStore;
  /** The sandbox workspace the runner indexes. */
  workspace: string;
  warn(message: string): void;
}

/**
 * The "@" file-reference feature, plugged into the lifecycle as hooks: the
 * file-reference row enables capture with its options, the engine calls
 * beforeHibernate with the still-answering runner, and the saved index is
 * served while the session stays hibernated and dropped once it is released.
 * The row's RPC methods on the manager are one-line delegates to this class.
 */
export class FileIndexHooks implements LifecycleHooks {
  private options: FileIndexOptions | undefined;

  constructor(private readonly deps: FileIndexHooksDependencies) {}

  /** The file-reference row enabled capture: what to index at hibernation. */
  enable(options: FileIndexOptions): void {
    this.options = options;
  }

  /**
   * The file index saved when this session hibernated or was checkpointed.
   * Undefined while the sandbox is running (ask the runner instead), or when
   * no index was saved.
   */
  async hibernatedFileIndex(agent: Agent): Promise<FileIndex | undefined> {
    const sessionId = String(agent.id);
    const state = this.deps.store.get(sessionId)?.state;
    if (state !== "hibernated" && state !== "checkpointed") {
      return undefined;
    }
    return this.deps.fileIndexes.load(sessionId);
  }

  /**
   * Index the workspace through the still-running runner, just before the
   * sandbox suspends or is checkpointed. A failure here only costs the fast
   * path ("@" then wakes the sandbox), so it never blocks hibernation.
   */
  async beforeHibernate(context: {
    sessionId: string;
    client: RunnerClient | undefined;
  }): Promise<void> {
    const client = context.client;
    if (client === undefined || this.options === undefined) {
      return;
    }
    try {
      const index = await captureFileIndex(
        client,
        this.deps.workspace,
        this.options,
      );
      await this.deps.fileIndexes.save(context.sessionId, index);
    } catch (error) {
      await this.deps.fileIndexes.remove(context.sessionId).catch(() => {});
      this.deps.warn(
        `could not index files for ${context.sessionId} before hibernation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The session is gone; its index has no future either. */
  async afterRelease(record: SessionRecord): Promise<void> {
    await this.deps.fileIndexes.remove(record.sessionId);
  }
}
