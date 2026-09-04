/**
 * Sandbox implementation of `ctx.fileReferences`: "@" file discovery rooted in
 * the session's sandbox workspace, driven through the runner instead of the
 * host filesystem.
 *
 * The stock dsh provider (`dsh-file-reference-local`) walks the session cwd on
 * the host, which for this distribution is a bookkeeping anchor directory that
 * holds no repository content. Discovery must read the tree the runner owns.
 *
 * @module @zhming0/dsh-workbench/file-reference
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import FileReferenceService, {
  FILE_REFERENCE_PROMPT,
  type FileReferenceCandidate,
} from "@deepseek-ai/dsh-file-reference";
import type {} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import { captureFileIndex, type FileIndex } from "./file-index.js";

/** Maximum ranked candidates returned for one query. */
export const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20;
/** Maximum indexed files and directories per agent workspace. */
export const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 50_000;
/**
 * Directory basenames the runner never traverses or offers. Mirrors the stock
 * local provider so "@" behaves identically to a local dsh host.
 */
export const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
] as const;

/** Sandbox file-reference discovery configuration. */
export interface Config {
  /** Maximum ranked candidates returned for one query. */
  maxResults?: number;
  /** Maximum indexed files and directories per agent workspace. */
  maxEntries?: number;
  /** Directory basenames never traversed or offered. */
  excludedDirectories?: string[];
}

interface Snapshot {
  entries: FileReferenceCandidate[];
  /** Invalidation counter observed when the snapshot was fetched. */
  startedAt: number;
}

/**
 * Per-agent snapshots of the sandbox workspace tree. A running sandbox is
 * walked through its runner; a hibernated one answers from the index the
 * manager saved as it suspended, so typing "@" never wakes a sandbox.
 */
export class SandboxFileReferenceService extends FileReferenceService {
  static inject = ["sandboxManager", "agents"];
  static Config: z<Config> = z.object({
    maxResults: z
      .number()
      .step(1)
      .min(1)
      .default(DEFAULT_FILE_SEARCH_MAX_RESULTS),
    maxEntries: z
      .number()
      .step(1)
      .min(1)
      .default(DEFAULT_FILE_SEARCH_MAX_ENTRIES),
    excludedDirectories: z
      .array(z.string())
      .default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES]),
  });

  private readonly maxResults: number;
  private readonly maxEntries: number;
  private readonly excludedDirectories: string[];
  private readonly snapshots = new Map<Agent, Snapshot>();
  private readonly refreshes = new Map<Agent, Promise<Snapshot>>();
  private readonly invalidations = new Map<Agent, number>();
  private readonly truncationWarned = new Set<Agent>();
  private readonly promptFibers = new Map<
    Agent,
    ReturnType<Context["inject"]>
  >();
  private readonly promptDisposals = new Set<Promise<void>>();
  private disposed = false;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.maxResults = config.maxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS;
    this.maxEntries = config.maxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES;
    this.excludedDirectories = config.excludedDirectories
      ? [...config.excludedDirectories]
      : [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES];
    validateConfig({
      maxResults: this.maxResults,
      maxEntries: this.maxEntries,
      excludedDirectories: this.excludedDirectories,
    });
    ctx.sandboxManager.indexFilesOnHibernate({
      excludedDirectories: this.excludedDirectories,
      maxEntries: this.maxEntries,
    });

    const installPrompt = (agent: Agent): void => {
      if (this.promptFibers.has(agent)) {
        return;
      }
      const fiber = agent.ctx.inject(["systemPrompt", "tools"], (scope) => {
        scope.systemPrompt.section({
          name: "context:file-reference",
          order: scope.systemPrompt.getSectionOrder("FILE_REFERENCE"),
          text: () =>
            agent.ctx.tools.get("read", agent) === undefined
              ? ""
              : FILE_REFERENCE_PROMPT,
        });
      });
      this.promptFibers.set(agent, fiber);
    };
    const disposePrompt = (agent: Agent): void => {
      const fiber = this.promptFibers.get(agent);
      if (fiber === undefined) {
        return;
      }
      this.promptFibers.delete(agent);
      const task = fiber.dispose().catch((error: unknown) => {
        ctx.logger.warn(
          `sandbox-file-reference: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      this.promptDisposals.add(task);
      void task.finally(() => {
        this.promptDisposals.delete(task);
      });
    };
    for (const agent of ctx.agents.list()) {
      installPrompt(agent);
    }
    ctx.on("agent/created", ({ agent }) => {
      installPrompt(agent);
    });
    ctx.on("agent/disposed", ({ agent }) => {
      this.snapshots.delete(agent);
      this.refreshes.delete(agent);
      this.invalidations.delete(agent);
      this.truncationWarned.delete(agent);
      disposePrompt(agent);
    });
    ctx.on("session/event", (session, event) => {
      if (event.type !== "tool/result") {
        return;
      }
      const agent = ctx.agents.get(session.id);
      if (agent !== undefined) {
        this.invalidate(agent);
      }
    });
    ctx.effect(
      () => async () => {
        this.disposed = true;
        this.snapshots.clear();
        this.refreshes.clear();
        this.invalidations.clear();
        this.truncationWarned.clear();
        const promptFibers = [...this.promptFibers.values()];
        this.promptFibers.clear();
        await Promise.all([
          ...promptFibers.map((fiber) => fiber.dispose()),
          ...this.promptDisposals,
        ]);
      },
      "sandbox-file-reference: disposal",
    );
  }

  /**
   * List file and directory candidates inside the agent's sandbox workspace.
   * @param agent - target agent whose session cwd bounds discovery.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates, relative to the workspace.
   */
  override async list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted();
    if (this.disposed) {
      return [];
    }
    const rawQuery = query.replaceAll("\\", "/");
    const slash = rawQuery.lastIndexOf("/");
    if (rawQuery === "" || slash >= 0) {
      const directory = slash < 0 ? "" : rawQuery.slice(0, slash + 1);
      const fragment = slash < 0 ? "" : rawQuery.slice(slash + 1);
      return this.listDirectory(agent, directory, fragment, signal);
    }
    const snapshot = await this.snapshot(agent, signal, false);
    const candidates = snapshot.entries.filter((candidate) =>
      visibleForGlobalQuery(candidate.path, rawQuery),
    );
    return rankCandidates(candidates, rawQuery, this.maxResults);
  }

  /**
   * Invalidate one agent's snapshot; the next query fetches a fresh tree. The
   * walk waits for that query rather than running after every tool result.
   */
  private invalidate(agent: Agent): void {
    this.invalidations.set(agent, (this.invalidations.get(agent) ?? 0) + 1);
  }

  /**
   * Return the freshest available snapshot. `preferFresh` waits for a refresh
   * when the settled snapshot is stale (directory browsing wants to see files
   * an agent just wrote); otherwise a stale snapshot answers while its
   * replacement builds behind the caret.
   */
  private async snapshot(
    agent: Agent,
    signal: AbortSignal,
    preferFresh: boolean,
  ): Promise<Snapshot> {
    const settled = this.snapshots.get(agent);
    const stale =
      settled === undefined ||
      settled.startedAt < (this.invalidations.get(agent) ?? 0);
    if (!stale) {
      return settled;
    }
    if (preferFresh || settled === undefined) {
      return waitFor(this.refresh(agent), signal);
    }
    void this.refresh(agent).catch(() => {});
    return settled;
  }

  /** Fetch one fresh snapshot for an agent through its runner. */
  private refresh(agent: Agent): Promise<Snapshot> {
    const existing = this.refreshes.get(agent);
    if (existing !== undefined) {
      return existing;
    }
    const startedAt = this.invalidations.get(agent) ?? 0;
    const task = this.fetch(agent).then(
      (index): Snapshot => {
        this.refreshes.delete(agent);
        if (this.disposed) {
          return { entries: [], startedAt };
        }
        if (index.truncated && !this.truncationWarned.has(agent)) {
          this.truncationWarned.add(agent);
          this.ctx.logger.warn(
            `sandbox-file-reference: workspace has more than ${this.maxEntries} entries; "@" only sees the first ${this.maxEntries}`,
          );
        }
        const snapshot = { entries: index.entries, startedAt };
        this.snapshots.set(agent, snapshot);
        return snapshot;
      },
      (error: unknown) => {
        this.refreshes.delete(agent);
        throw error;
      },
    );
    this.refreshes.set(agent, task);
    return task;
  }

  /**
   * A hibernated session answers from the index saved as it suspended, so
   * typing "@" does not pay for a wake. Otherwise (running, still
   * provisioning, or hibernated without an index) the runner walks the tree.
   */
  private async fetch(agent: Agent): Promise<FileIndex> {
    const manager = this.ctx.sandboxManager;
    const saved = await manager.hibernatedFileIndex(agent);
    if (saved !== undefined) {
      return saved;
    }
    const client = await manager.ensureRunning(agent);
    return captureFileIndex(client, manager.workspace, {
      excludedDirectories: this.excludedDirectories,
      maxEntries: this.maxEntries,
    });
  }

  /**
   * Directory-scoped listing. Candidates are the immediate children of the
   * requested directory within the snapshot; the root directory lists the
   * workspace top level.
   */
  private async listDirectory(
    agent: Agent,
    directory: string,
    fragment: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    if (
      directory
        .split("/")
        .some((segment) => this.excludedDirectories.includes(segment))
    ) {
      return [];
    }
    const prefix = directory.split("/").filter(Boolean);
    const snapshot = await this.snapshot(agent, signal, true);
    const prefixText = prefix.join("/");
    const candidates: FileReferenceCandidate[] = [];
    for (const candidate of snapshot.entries) {
      const segments = candidate.path.split("/");
      if (segments.length !== prefix.length + 1) {
        continue;
      }
      if (
        prefix.length > 0 &&
        segments.slice(0, prefix.length).join("/") !== prefixText
      ) {
        continue;
      }
      const name = segments[segments.length - 1]!;
      if (name.startsWith(".") && !fragment.startsWith(".")) {
        continue;
      }
      candidates.push(candidate);
    }
    return rankCandidates(candidates, fragment, this.maxResults);
  }
}

function validateConfig(config: {
  maxResults: number;
  maxEntries: number;
  excludedDirectories: string[];
}): void {
  if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
    throw new Error("file search maxResults must be a positive safe integer");
  }
  if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
    throw new Error("file search maxEntries must be a positive safe integer");
  }
  if (
    config.excludedDirectories.some(
      (name) => name.length === 0 || name.includes("/") || name.includes("\\"),
    )
  ) {
    throw new Error(
      "file search excludedDirectories entries must be non-empty directory basenames",
    );
  }
}

function visibleForGlobalQuery(path: string, query: string): boolean {
  if (query.startsWith(".") || query.includes("/.")) {
    return true;
  }
  return !path.split("/").some((segment) => segment.startsWith("."));
}

function rankCandidates(
  candidates: readonly FileReferenceCandidate[],
  query: string,
  limit: number,
): FileReferenceCandidate[] {
  const ranked: { candidate: FileReferenceCandidate; score: number }[] = [];
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query);
    if (score !== undefined) {
      ranked.push({ candidate, score });
    }
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      kindRank(left.candidate.kind) - kindRank(right.candidate.kind) ||
      (query === ""
        ? 0
        : left.candidate.path.length - right.candidate.path.length) ||
      compareText(left.candidate.path, right.candidate.path),
  );
  return ranked.slice(0, limit).map((entry) => entry.candidate);
}

function scoreCandidate(
  candidate: FileReferenceCandidate,
  query: string,
): number | undefined {
  if (query === "") {
    return 0;
  }
  const path = candidate.path.toLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const needle = query.toLowerCase();
  const directoryBonus = candidate.kind === "directory" ? 25 : 0;
  if (name === needle) {
    return 1_000 + directoryBonus;
  }
  if (name.startsWith(needle)) {
    return 900 + directoryBonus;
  }
  if (name.includes(needle)) {
    return 700 + directoryBonus;
  }
  if (path.includes(needle)) {
    return 500 + directoryBonus;
  }
  const subsequence = subsequenceScore(path, needle);
  return subsequence === undefined
    ? undefined
    : 300 + subsequence + directoryBonus;
}

function subsequenceScore(target: string, query: string): number | undefined {
  let targetIndex = 0;
  let gap = 0;
  for (const character of query) {
    const found = target.indexOf(character, targetIndex);
    if (found < 0) {
      return undefined;
    }
    gap += found - targetIndex;
    targetIndex = found + 1;
  }
  return Math.max(0, 100 - gap);
}

function kindRank(kind: FileReferenceCandidate["kind"]): number {
  return kind === "directory" ? 0 : 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      rejectPromise(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(
          error instanceof Error ? error : new Error(String(error)),
        );
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("file search aborted");
}

export default SandboxFileReferenceService;
