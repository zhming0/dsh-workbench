import type { CredentialBroker } from "../broker.js";
import {
  restoreCheckpoint,
  saveCheckpoint,
  type SavedCheckpoint,
} from "../checkpoint.js";
import type { RunnerClient } from "../runner-client.js";
import type { RunnerGateway } from "../tunnel.js";
import type { RunningRecord, SessionRecord } from "../types.js";

export interface RunnerAttachmentDependencies {
  gateway: RunnerGateway;
  broker: CredentialBroker;
  revision: string;
  workspace: string;
}

/**
 * The live runner handle of each session: the cached-client fast path, the
 * wait-for-registration plus secret/credential push and setup dance, and
 * eviction when a runner dies or a session ends. The lifecycle decides *when*
 * a session needs a runner; this class owns the runners themselves.
 */
export class RunnerAttachment {
  private readonly clients = new Map<string, RunnerClient>();

  constructor(private readonly deps: RunnerAttachmentDependencies) {}

  /** The cached runner of one session, if it is still registered. */
  clientFor(sessionId: string): RunnerClient | undefined {
    return this.clients.get(sessionId);
  }

  /**
   * The cached-client fast path: answer with the live runner after checking
   * its health and identity and refreshing its secrets. Undefined once the
   * cached runner is unusable (and evicted), or when there is none.
   */
  async reuseCached(
    sessionId: string,
    record: SessionRecord | undefined,
  ): Promise<RunnerClient | undefined> {
    const cached = this.clients.get(sessionId);
    if (cached === undefined || record?.state !== "running") {
      return undefined;
    }
    try {
      const health = await cached.health({ timeoutMs: 5_000 });
      if (health.sandboxId !== record.sandboxId) {
        throw new Error("runner identity changed");
      }
      await this.pushCredentials(cached, record.repositoryUrl);
      return cached;
    } catch {
      this.clients.delete(sessionId);
      return undefined;
    }
  }

  /**
   * Attach the record's runner: wait for its registration, then push secrets
   * and git credentials and run setup. With a checkpoint the sandbox is a
   * fresh one replacing one that was released: after the usual clone and
   * `.agents/setup`, the restore puts the session's commits and working tree
   * back. Registers the client in the cache.
   */
  async attach(
    record: RunningRecord,
    repositoryUrl: string,
    checkpoint?: SavedCheckpoint,
  ): Promise<RunnerClient> {
    const client = await this.waitForRunner(record);
    await this.pushCredentials(client, repositoryUrl);
    await client.setup({
      repositoryUrl,
      revision: this.deps.revision,
      workspace: this.deps.workspace,
    });
    if (checkpoint !== undefined) {
      await restoreCheckpoint(
        client,
        this.deps.workspace,
        checkpoint.checkpoint,
        checkpoint.bundle,
      );
    }
    this.clients.set(record.sessionId, client);
    return client;
  }

  /**
   * The record's runner, reconnecting when a host restart left no cached
   * client. The caller has already confirmed the sandbox is alive. Registers
   * the client in the cache.
   */
  async connect(record: RunningRecord): Promise<RunnerClient> {
    let client = this.clients.get(record.sessionId);
    if (client === undefined) {
      client = await this.waitForRunner(record);
      this.clients.set(record.sessionId, client);
    }
    return client;
  }

  /**
   * Commit the session's working tree through the still-running runner and
   * bring the commits the remote lacks back as a bundle.
   */
  async checkpoint(record: RunningRecord): Promise<SavedCheckpoint> {
    const client = await this.connect(record);
    return saveCheckpoint(client, this.deps.workspace);
  }

  private async pushCredentials(
    client: RunnerClient,
    repositoryUrl: string,
  ): Promise<void> {
    await this.deps.broker.refresh();
    await client.setSecrets(this.deps.broker.secrets());
    await client.setGitCredentials(
      await this.deps.broker.gitCredentials(repositoryUrl),
    );
  }

  /** Forget a session's runner handle. */
  evict(sessionId: string): void {
    this.clients.delete(sessionId);
  }

  /** Sever a runner's tunnel registration, if it has one. */
  drop(sandboxId: string): void {
    this.deps.gateway.drop(sandboxId);
  }

  /** evict() plus drop(): the session's runner is going away. */
  detach(sessionId: string, sandboxId: string): void {
    this.evict(sessionId);
    this.drop(sandboxId);
  }

  private async waitForRunner(record: {
    sandboxId: string;
  }): Promise<RunnerClient> {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const client = await this.deps.gateway.waitFor(
          record.sandboxId,
          Math.max(deadline - Date.now(), 1),
        );
        const health = await client.health({ timeoutMs: 5_000 });
        if (health.sandboxId !== record.sandboxId) {
          throw new Error(
            `runner identity mismatch: expected ${record.sandboxId}, got ${health.sandboxId}`,
          );
        }
        return client;
      } catch (error) {
        lastError = error;
        // Sever a registration whose tunnel cannot answer a health probe so
        // the runner reconnects instead of staying wedged.
        this.deps.gateway.drop(record.sandboxId);
        await delay(500);
      }
    }
    throw new Error(`runner did not become healthy: ${String(lastError)}`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
