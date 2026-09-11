/**
 * Copy uploaded attachments into the session's sandbox.
 *
 * dsh stores uploaded file bytes on the dsh host and asks the mounted
 * filesystem to translate their host path into the tool execution world. A
 * remote sandbox shares no path with that host, so `SandboxFileSystem` cannot
 * answer with one and the model receives dsh's "cannot access a readable
 * path" placeholder. This module closes that gap: before a request is
 * assembled it copies every attachment the request references into the
 * sandbox workspace, and records the host-to-sandbox mapping that the
 * filesystem's synchronous lookup answers with.
 *
 * Copies are keyed by root session, so a subagent shares its root's copy, and
 * best-effort: a copy that fails leaves dsh's placeholder in place instead of
 * failing the request.
 *
 * @module @zhming0/dsh-workbench/attachment-copies
 */

import { posix } from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";

import type { RunnerClient } from "./runner-client.js";
import { isInsideSandboxWorkspace } from "./sandbox-path.js";

/** Attachment copies live beside the repository checkout, never inside it. */
export const ATTACHMENT_COPY_DIRECTORY = ".dsh-attachments";

/**
 * Largest attachment copied into a sandbox. One unary `WriteFile` carries the
 * whole file and the runner buffers it, so a larger upload keeps dsh's
 * placeholder instead of risking memory on both ends of the tunnel.
 */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/**
 * The durable fields of one file attachment this module reads. dsh owns the
 * full reference; only these fields cross the boundary.
 */
export interface FileAttachmentRef {
  readonly attachmentId: string;
  readonly name: string;
  readonly bytes: number;
}

/** The message fields this module reads; dsh owns the full message shape. */
export interface MessageLike {
  readonly content: readonly ContentBlock[];
}

/** Every file attachment one request references, nested tool results included. */
export function collectFileAttachments(
  messages: readonly MessageLike[],
): FileAttachmentRef[] {
  const refs: FileAttachmentRef[] = [];
  for (const message of messages) {
    collectBlocks(message.content, refs);
  }
  return refs;
}

function collectBlocks(
  blocks: readonly ContentBlock[],
  refs: FileAttachmentRef[],
): void {
  for (const block of blocks) {
    if (block.type === "file") {
      refs.push(block.attachment);
    } else if (block.type === "tool-result") {
      collectBlocks(block.content, refs);
    }
  }
}

/**
 * Where one attachment's copy lives inside the sandbox, or undefined when the
 * reference cannot name a path inside the copy directory. The leaf keeps the
 * display name so the model's handle text stays recognizable.
 */
export function attachmentSandboxPath(
  workspace: string,
  ref: FileAttachmentRef,
): string | undefined {
  const digest = ref.attachmentId
    .replace(/^sha256:/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  const leaf = safeLeafName(ref.name);
  if (digest.length === 0 || leaf === undefined) {
    return undefined;
  }
  const directory = posix.join(workspace, ATTACHMENT_COPY_DIRECTORY);
  const path = posix.join(directory, digest, leaf);
  // The name is sanitized above; this asserts the boundary rather than
  // trusting it, because a path outside the copy directory would escape the
  // sandbox workspace.
  return isInsideSandboxWorkspace(path, directory) ? path : undefined;
}

function safeLeafName(name: string): string | undefined {
  const leaf = posix.basename(name.replaceAll("\\", "/"));
  if (leaf === "" || leaf === "." || leaf === ".." || leaf.includes("\0")) {
    return undefined;
  }
  return leaf;
}

/** What the copier needs from the mounted dsh services and the runner. */
export interface AttachmentCopyDeps {
  /** Sandbox workspace root; copies live under it. */
  workspace(): string;
  /** Root session owning the calling agent's sandbox, or undefined outside an agent boundary. */
  sessionKey(): string | undefined;
  /** Runner for the calling agent; may provision or wake its sandbox. */
  client(): Promise<RunnerClient>;
  /** Absolute host path of one stored attachment, or undefined when the backend has none. */
  hostPath(ref: FileAttachmentRef): string | undefined;
  /** Read the stored bytes on the host. */
  readBytes(hostPath: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** Report one skip or failure without failing the request. */
  warn(message: string): void;
}

/** Host-to-sandbox paths of the attachments already copied, per root session. */
export class AttachmentCopies {
  private readonly bySession = new Map<string, Map<string, string>>();
  private readonly warned = new Set<string>();

  constructor(private readonly deps: AttachmentCopyDeps) {}

  /**
   * Copy every referenced attachment that the calling agent's sandbox does not
   * have yet. Best effort by design: the caller is request assembly, and a
   * failed copy must degrade to dsh's placeholder, never to a failed request.
   */
  async ensure(
    refs: readonly FileAttachmentRef[],
    signal?: AbortSignal,
  ): Promise<void> {
    const session = this.deps.sessionKey();
    if (session === undefined || refs.length === 0) {
      return;
    }
    const copies = this.copiesFor(session);
    for (const ref of refs) {
      if (signal?.aborted === true) {
        return;
      }
      await this.ensureOne(session, copies, ref, signal);
    }
  }

  /**
   * The sandbox path already copied for this host path, or undefined when the
   * calling agent has no copy. Synchronous by contract: dsh-llm calls this
   * while assembling a request, and a throw there fails the request, so this
   * never throws.
   */
  lookup(hostPath: string): string | undefined {
    try {
      const session = this.deps.sessionKey();
      return session === undefined
        ? undefined
        : this.bySession.get(session)?.get(hostPath);
    } catch {
      return undefined;
    }
  }

  private async ensureOne(
    session: string,
    copies: Map<string, string>,
    ref: FileAttachmentRef,
    signal?: AbortSignal,
  ): Promise<void> {
    let hostPath: string | undefined;
    const warningKey = `${session}\u0000${ref.attachmentId}`;
    try {
      hostPath = this.deps.hostPath(ref);
    } catch (error) {
      this.warnOnce(
        warningKey,
        `cannot locate attachment "${ref.name}": ${describe(error)}`,
      );
      return;
    }
    if (hostPath === undefined || copies.has(hostPath)) {
      return;
    }
    const target = attachmentSandboxPath(this.deps.workspace(), ref);
    if (target === undefined) {
      this.warnOnce(
        warningKey,
        `attachment "${ref.name}" has no path inside the sandbox workspace`,
      );
      return;
    }
    if (ref.bytes > MAX_ATTACHMENT_BYTES) {
      this.warnOnce(
        warningKey,
        `attachment "${ref.name}" is ${ref.bytes} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte copy limit`,
      );
      return;
    }
    try {
      const bytes = await this.deps.readBytes(hostPath, signal);
      await this.write(session, hostPath, target, bytes, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        return;
      }
      this.warnOnce(
        warningKey,
        `cannot copy attachment "${ref.name}" into the sandbox: ${describe(error)}`,
      );
    }
  }

  private async write(
    session: string,
    hostPath: string,
    target: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const client = await this.deps.client();
    try {
      await client.writeFile(
        {
          path: target,
          content: bytes,
          guard: { case: "createIfAbsent", value: true },
        },
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      // A copy from an earlier process already sits in the workspace volume,
      // which survives hibernation, so an existing target is success.
      if (ConnectError.from(error).code !== Code.AlreadyExists) {
        throw error;
      }
    }
    this.copiesFor(session).set(hostPath, target);
  }

  private copiesFor(session: string): Map<string, string> {
    let copies = this.bySession.get(session);
    if (copies === undefined) {
      copies = new Map();
      this.bySession.set(session, copies);
    }
    return copies;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    this.deps.warn(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
