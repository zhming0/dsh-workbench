import type { RunnerClient } from "../runner-client.js";
import type {
  SandboxHostFacts,
  SandboxLiveFacts,
  SandboxStatusView,
} from "../sandbox-status-remote.js";
import type { SessionStore } from "../state-store.js";
import {
  provisionsFromImage,
  type SandboxProfile,
  type SessionRecord,
} from "../types.js";

/** Bound on the machine's own account of itself; the tab is a glance, not a wait. */
const LIVE_FACTS_TIMEOUT_MS = 5_000;

export interface SandboxStatusDependencies {
  store: SessionStore;
  profiles: Record<string, SandboxProfile>;
  /**
   * The attached runner of one session, or undefined when it has none. This is
   * a read: the caller supplies a lookup that cannot provision or wake.
   */
  runnerFor: (sessionId: string) => RunnerClient | undefined;
}

/**
 * What the Sandbox tab shows about one session's sandbox: the host's own
 * record, plus the machine's account of itself when a runner is attached.
 *
 * Reading a status is deliberately inert. It never provisions, wakes, or marks
 * a session active, which is why it holds a store, a profile map, and a
 * read-only runner lookup — and no lifecycle engine. A hibernated or
 * checkpointed sandbox therefore reports what the host knows and stops there,
 * instead of paying to boot a machine so it can describe itself.
 */
export class SandboxStatus {
  constructor(private readonly deps: SandboxStatusDependencies) {}

  async view(sessionId: string): Promise<SandboxStatusView> {
    const record = this.deps.store.get(sessionId);
    if (record === undefined) {
      return {};
    }
    const view: SandboxStatusView = { sandbox: this.hostFacts(record) };
    // Only a running sandbox has a runner attached, and only an attached
    // runner can answer for the machine. The attachment is keyed by session.
    if (record.state === "running") {
      const live = await this.liveFacts(sessionId);
      if (live !== undefined) {
        view.live = live;
      }
    }
    return view;
  }

  /**
   * The record's own fields, shaped for the browser. Only a live or parked
   * sandbox has a handle to name, and only a parked one has a deadline.
   */
  private hostFacts(record: SessionRecord): SandboxHostFacts {
    const facts: SandboxHostFacts = {
      backend: record.backend,
      profile: record.profile,
      state: record.state,
      repositoryUrl: record.repositoryUrl,
      startedAt: record.createdAt,
    };
    const profile = this.deps.profiles[record.profile];
    // A removed profile keeps its sessions readable; the image goes with it.
    if (profile !== undefined && provisionsFromImage(profile)) {
      facts.image = profile.image;
    }
    if (record.state !== "checkpointed") {
      facts.sandboxId = record.sandboxId;
    }
    if (record.state !== "running") {
      facts.expiresAt = record.expiresAt;
    }
    return facts;
  }

  /** The attached runner's own account of the machine, if it has one. */
  private async liveFacts(
    sessionId: string,
  ): Promise<SandboxLiveFacts | undefined> {
    const client = this.deps.runnerFor(sessionId);
    if (client === undefined) {
      return undefined;
    }
    try {
      const status = await client.sandboxStatus({
        timeoutMs: LIVE_FACTS_TIMEOUT_MS,
      });
      return {
        hostname: status.hostname,
        osName: status.osName,
        kernelVersion: status.kernelVersion,
        architecture: status.architecture,
        cpuCount: status.cpuCount,
        memoryTotalBytes: Number(status.memoryTotalBytes),
        workspaceDiskUsedBytes: Number(status.workspaceDiskUsedBytes),
        workspaceDiskTotalBytes: Number(status.workspaceDiskTotalBytes),
        filesystemDiskUsedBytes: Number(status.filesystemDiskUsedBytes),
        filesystemDiskTotalBytes: Number(status.filesystemDiskTotalBytes),
        uptimeSeconds: Number(status.uptimeSeconds),
      };
    } catch {
      // A runner that stopped answering is not an error to report here: the
      // tab shows the host facts and the next turn replaces the runner.
      return undefined;
    }
  }
}
