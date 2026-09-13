import {
  captureFileIndex,
  FileIndexStore,
  type FileIndex,
  type FileIndexOptions,
} from "../file-index.js";
import type { RunnerClient } from "../runner-client.js";
import type { SessionStore } from "../state-store.js";
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
 * beforeHibernate or beforeCheckpoint with the still-answering runner, and
 * the saved index is served while the session has no live sandbox and dropped
 * once it is released. The row's RPC methods on the manager are one-line
 * delegates to this class.
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
   * no index was saved. The manager resolves the root session id before
   * delegating.
   */
  async hibernatedFileIndex(sessionId: string): Promise<FileIndex | undefined> {
    const state = this.deps.store.get(sessionId)?.state;
    if (state !== "hibernated" && state !== "checkpointed") {
      return undefined;
    }
    return this.deps.fileIndexes.load(sessionId);
  }

  /** Index the workspace just before the sandbox hibernates, when a runner is cached. */
  async beforeHibernate(context: {
    sessionId: string;
    client: RunnerClient | undefined;
  }): Promise<void> {
    if (context.client !== undefined) {
      await this.capture(context.sessionId, context.client);
    }
  }

  /** Index the workspace just before the sandbox is checkpointed and destroyed. */
  async beforeCheckpoint(context: {
    sessionId: string;
    client: RunnerClient;
  }): Promise<void> {
    await this.capture(context.sessionId, context.client);
  }

  /**
   * Index the workspace through the still-running runner. A failure here only
   * costs the fast path ("@" then wakes the sandbox), so it never blocks the
   * transition.
   */
  private async capture(
    sessionId: string,
    client: RunnerClient,
  ): Promise<void> {
    if (this.options === undefined) {
      return;
    }
    try {
      const index = await captureFileIndex(
        client,
        this.deps.workspace,
        this.options,
      );
      await this.deps.fileIndexes.save(sessionId, index);
    } catch (error) {
      await this.deps.fileIndexes.remove(sessionId).catch(() => {});
      this.deps.warn(
        `could not index files for ${sessionId} before the sandbox stops: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The session is gone; its index has no future either. */
  async afterRelease(sessionId: string): Promise<void> {
    await this.deps.fileIndexes.remove(sessionId);
  }
}
