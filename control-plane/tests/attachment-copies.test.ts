import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ContentBlock, StreamChunk } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_COPY_DIRECTORY,
  AttachmentCopies,
  MAX_ATTACHMENT_BYTES,
  attachmentSandboxPath,
  collectFileAttachments,
  type FileAttachmentRef,
  type MessageLike,
} from "../src/attachment-copies.js";
import SandboxFileSystem from "../src/fs.js";
import type { RunnerClient } from "../src/runner-client.js";

const NOTES: FileAttachmentRef = {
  attachmentId: "sha256:cd",
  name: "notes.md",
  bytes: 5,
};
const HOST_PATH = "/data/.dsh/attachments/v1/files/cd/notes.md";
const SANDBOX_PATH = `/workspace/${ATTACHMENT_COPY_DIRECTORY}/cd/notes.md`;

function fileBlock(attachment: FileAttachmentRef): ContentBlock {
  return { type: "file", attachment } as unknown as ContentBlock;
}

function message(content: ContentBlock[]): MessageLike {
  return { content };
}

interface Write {
  path: string;
  content: Uint8Array;
}

function fakeClient(
  writes: Write[],
  fail: (() => never) | undefined = undefined,
): RunnerClient {
  return {
    writeFile: async (request: { path: string; content: Uint8Array }) => {
      fail?.();
      writes.push({ path: request.path, content: request.content });
      return {
        created: true,
        hadBefore: false,
        before: new Uint8Array(),
        version: "1",
      };
    },
  } as unknown as RunnerClient;
}

function makeCopies(options: {
  hostPaths?: Map<string, string>;
  client?: RunnerClient;
  bytes?: Uint8Array;
  session?: string | undefined;
}) {
  const writes: Write[] = [];
  const warnings: string[] = [];
  const hostPaths =
    options.hostPaths ?? new Map([[NOTES.attachmentId, HOST_PATH]]);
  const copies = new AttachmentCopies({
    workspace: () => "/workspace",
    sessionKey: () => options.session,
    client: async () => options.client ?? fakeClient(writes),
    hostPath: (ref) => hostPaths.get(ref.attachmentId),
    readBytes: async () => options.bytes ?? new TextEncoder().encode("hello"),
    warn: (warning) => warnings.push(warning),
  });
  return { copies, writes, warnings };
}

describe("collectFileAttachments", () => {
  it("collects file blocks, nested tool results included", () => {
    const nested = { ...NOTES, attachmentId: "sha256:ef", name: "log.txt" };
    const messages = [
      message([{ type: "text", text: "see attached" }, fileBlock(NOTES)]),
      message([
        {
          type: "tool-result",
          toolCallId: "call-one",
          content: [fileBlock(nested)],
        } as unknown as ContentBlock,
      ]),
      message([
        {
          type: "image",
          attachment: { attachmentId: "sha256:aa" },
        } as unknown as ContentBlock,
      ]),
    ];
    expect(collectFileAttachments(messages)).toEqual([NOTES, nested]);
  });
});

describe("attachmentSandboxPath", () => {
  it("keeps the display name under the content-addressed digest", () => {
    expect(attachmentSandboxPath("/workspace", NOTES)).toBe(SANDBOX_PATH);
  });

  it("reduces a path-like name to its leaf", () => {
    expect(
      attachmentSandboxPath("/workspace", {
        ...NOTES,
        name: "../../etc/passwd",
      }),
    ).toBe(`/workspace/${ATTACHMENT_COPY_DIRECTORY}/cd/passwd`);
  });

  it("refuses a name that cannot be a leaf", () => {
    expect(attachmentSandboxPath("/workspace", { ...NOTES, name: ".." })).toBe(
      undefined,
    );
    expect(
      attachmentSandboxPath("/workspace", { ...NOTES, name: "" }),
    ).toBeUndefined();
    expect(
      attachmentSandboxPath("/workspace", {
        ...NOTES,
        attachmentId: "sha256:",
      }),
    ).toBeUndefined();
  });
});

describe("AttachmentCopies", () => {
  it("copies a referenced attachment and maps its host path", async () => {
    const { copies, writes } = makeCopies({ session: "session-one" });
    await copies.ensure([NOTES]);
    expect(writes).toEqual([
      { path: SANDBOX_PATH, content: new TextEncoder().encode("hello") },
    ]);
    expect(copies.lookup(HOST_PATH)).toBe(SANDBOX_PATH);
  });

  it("copies once across repeated requests", async () => {
    const { copies, writes } = makeCopies({ session: "session-one" });
    await copies.ensure([NOTES]);
    await copies.ensure([NOTES, NOTES]);
    expect(writes).toHaveLength(1);
  });

  it("leaves an attachment the host cannot locate unmapped", async () => {
    const { copies, writes, warnings } = makeCopies({
      session: "session-one",
      hostPaths: new Map(),
    });
    await copies.ensure([NOTES]);
    expect(writes).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(copies.lookup(HOST_PATH)).toBeUndefined();
  });

  it("skips an attachment over the copy limit and says why", async () => {
    const { copies, writes, warnings } = makeCopies({ session: "session-one" });
    await copies.ensure([{ ...NOTES, bytes: MAX_ATTACHMENT_BYTES + 1 }]);
    expect(writes).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("over the");
  });

  it("treats an existing target as already copied", async () => {
    const writes: Write[] = [];
    const client = fakeClient(writes, () => {
      throw new ConnectError("exists", Code.AlreadyExists);
    });
    const { copies, warnings } = makeCopies({
      session: "session-one",
      client,
    });
    await copies.ensure([NOTES]);
    expect(copies.lookup(HOST_PATH)).toBe(SANDBOX_PATH);
    expect(warnings).toHaveLength(0);
  });

  it("reports one failure per attachment without throwing", async () => {
    const writes: Write[] = [];
    const client = fakeClient(writes, () => {
      throw new Error("runner is unavailable");
    });
    const { copies, warnings } = makeCopies({
      session: "session-one",
      client,
    });
    await copies.ensure([NOTES]);
    await copies.ensure([NOTES]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("runner is unavailable");
    expect(copies.lookup(HOST_PATH)).toBeUndefined();
  });

  it("does nothing outside an agent boundary", async () => {
    const { copies, writes } = makeCopies({ session: undefined });
    await copies.ensure([NOTES]);
    expect(writes).toHaveLength(0);
    expect(copies.lookup(HOST_PATH)).toBeUndefined();
  });

  it("keeps copies separate per root session", async () => {
    const hostPaths = new Map([[NOTES.attachmentId, HOST_PATH]]);
    let session: string | undefined = "session-one";
    const writes: Write[] = [];
    const copies = new AttachmentCopies({
      workspace: () => "/workspace",
      sessionKey: () => session,
      client: async () => fakeClient(writes),
      hostPath: (ref) => hostPaths.get(ref.attachmentId),
      readBytes: async () => new TextEncoder().encode("hello"),
      warn: () => {},
    });
    await copies.ensure([NOTES]);
    expect(copies.lookup(HOST_PATH)).toBe(SANDBOX_PATH);
    session = "session-two";
    expect(copies.lookup(HOST_PATH)).toBeUndefined();
  });
});

describe("SandboxFileSystem attachment mapping", () => {
  // The copy reads the stored bytes from the host, so the test gives it a real
  // file and lets the production dependency do the read.
  async function makeSandbox() {
    const directory = await mkdtemp(join(tmpdir(), "dsh-attachments-"));
    const hostPath = join(directory, "notes.md");
    await writeFile(hostPath, "hello");
    const ctx = new Context();
    const writes: Write[] = [];
    ctx.provide("sandboxManager", {
      workspace: "/workspace",
      clientForCurrentAgent: async () => fakeClient(writes),
      rootSessionIdForCurrentAgent: () => "session-one",
    });
    ctx.provide("agents", { requireInitiator: () => ({ id: "session-one" }) });
    ctx.provide("attachments", {
      fileHostPath: (ref: FileAttachmentRef) =>
        ref.attachmentId === NOTES.attachmentId ? hostPath : undefined,
    });
    const fs = new SandboxFileSystem(ctx);
    return {
      ctx,
      fs,
      writes,
      hostPath,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  }

  function dispatch(
    ctx: Context,
    messages: MessageLike[],
  ): AsyncIterable<StreamChunk> {
    return ctx.events.waterfall({}, "llm/stream", { messages }, () =>
      (async function* () {})(),
    ) as AsyncIterable<StreamChunk>;
  }

  it("maps a host attachment path after the request copies it", async () => {
    const { ctx, fs, writes, hostPath, cleanup } = await makeSandbox();
    try {
      expect(fs.processPathFromHostPath(hostPath)).toBeUndefined();
      for await (const _chunk of dispatch(ctx, [message([fileBlock(NOTES)])])) {
        // The downstream stream is empty; iteration drains the copy step.
      }
      expect(writes.map((write) => write.path)).toEqual([SANDBOX_PATH]);
      expect(new TextDecoder().decode(writes[0]?.content)).toBe("hello");
      expect(fs.processPathFromHostPath(hostPath)).toBe(SANDBOX_PATH);
    } finally {
      await cleanup();
    }
  });

  it("leaves an unmapped host path undefined without copying", async () => {
    const { ctx, fs, writes, cleanup } = await makeSandbox();
    try {
      for await (const _chunk of dispatch(ctx, [
        message([fileBlock({ ...NOTES, attachmentId: "sha256:beef" })]),
      ])) {
        // Nothing to assert beyond the absence of a copy.
      }
      expect(writes).toHaveLength(0);
      expect(fs.processPathFromHostPath("/data/elsewhere.md")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("returns undefined instead of throwing when no agent initiated the call", async () => {
    const ctx = new Context();
    ctx.provide("sandboxManager", {
      workspace: "/workspace",
      clientForCurrentAgent: async () => fakeClient([]),
      rootSessionIdForCurrentAgent: () => {
        throw new Error("no initiator");
      },
    });
    ctx.provide("agents", {
      requireInitiator: () => {
        throw new Error("no initiator");
      },
    });
    const fs = new SandboxFileSystem(ctx);
    expect(fs.processPathFromHostPath(HOST_PATH)).toBeUndefined();
  });
});
