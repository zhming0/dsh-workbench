import type { CredentialBroker } from "../broker.js";
import {
  restoreCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from "../checkpoint.js";
import type { RunnerClient } from "../runner-client.js";
import type { RunnerGateway } from "../tunnel.js";
import type { SessionRecord } from "../types.js";

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
   * and git credentials and run setup. A record carrying a checkpoint is a
   * fresh sandbox replacing one that was released: the clone checks the
   * checkpoint branch out so `.agents/setup` sees the restored tree, and the
   * restore then puts the session back on its own branch. Registers the
   * client in the cache.
   */
  async attach(
    record: SessionRecord,
    repositoryUrl: string,
  ): Promise<RunnerClient> {
    const client = await this.waitForRunner(record);
    await this.pushCredentials(client, repositoryUrl);
    await client.setup({
      repositoryUrl,
      revision: record.checkpoint?.ref ?? this.deps.revision,
      workspace: this.deps.workspace,
    });
    if (record.checkpoint !== undefined) {
      await restoreCheckpoint(client, this.deps.workspace, record.checkpoint);
    }
    this.clients.set(record.sessionId, client);
    return client;
  }

  /**
   * Push the session's working tree to its checkpoint branch through the
   * still-running runner. Reconnects after a host restart left no cached
   * client; the caller has already confirmed the sandbox is alive.
   */
  async checkpoint(record: SessionRecord): Promise<Checkpoint> {
    const client =
      this.clients.get(record.sessionId) ?? (await this.waitForRunner(record));
    // The push may run long after the last turn refreshed the credentials.
    await this.pushCredentials(client, record.repositoryUrl);
    return saveCheckpoint(client, this.deps.workspace, record.sessionId);
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

  private async waitForRunner(record: SessionRecord): Promise<RunnerClient> {
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
