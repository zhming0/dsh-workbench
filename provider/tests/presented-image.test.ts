import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem, FsInfo, FsTarget } from "@deepseek-ai/dsh-fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxManager } from "../src/manager/index.js";
import {
  MAX_PRESENTED_IMAGE_BYTES,
  readPresentedImage,
} from "../src/presented-image.js";
import { FakeBackend, gatewayFor } from "./fakes.js";

interface FakeFile {
  bytes: Uint8Array;
  type?: FsInfo["type"];
}

/** A filesystem provider backed by an in-memory path table. */
function fakeFs(files: Map<string, FakeFile>): FileSystem {
  return {
    async resolve(path: string): Promise<FsTarget> {
      return { targetKey: path, displayPath: path } as unknown as FsTarget;
    },
    async stat(target: FsTarget): Promise<FsInfo | undefined> {
      const file = files.get(String(target.targetKey));
      if (file === undefined) {
        return undefined;
      }
      return {
        version: "v1",
        type: file.type ?? "file",
        size: file.bytes.byteLength,
      } as unknown as FsInfo;
    },
    async readBytes(
      target: FsTarget,
      _signal: AbortSignal | undefined,
      maxBytes: number,
    ): Promise<Uint8Array> {
      const file = files.get(String(target.targetKey));
      if (file === undefined || file.bytes.byteLength > maxBytes) {
        throw new Error("cannot read");
      }
      return file.bytes;
    },
  } as unknown as FileSystem;
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("readPresentedImage", () => {
  it("returns base64 bytes and the media type of an image path", async () => {
    const fs = fakeFs(
      new Map([["/workspace/repository/art.png", { bytes: png }]]),
    );
    const image = await readPresentedImage(
      fs,
      "/workspace/repository/art.png",
      undefined,
    );
    expect(image).toEqual({
      path: "/workspace/repository/art.png",
      mediaType: "image/png",
      byteLength: png.byteLength,
      data: Buffer.from(png).toString("base64"),
    });
  });

  it("refuses a path whose extension is not an image", async () => {
    const fs = fakeFs(new Map());
    await expect(
      readPresentedImage(fs, "/workspace/repository/notes.txt", undefined),
    ).rejects.toThrow("not an image file");
  });

  it("refuses a missing path and a directory", async () => {
    const files = new Map<string, FakeFile>([
      [
        "/workspace/repository/dir.png",
        { bytes: new Uint8Array(), type: "directory" },
      ],
    ]);
    const fs = fakeFs(files);
    await expect(
      readPresentedImage(fs, "/nope.png", undefined),
    ).rejects.toThrow("not found");
    await expect(
      readPresentedImage(fs, "/workspace/repository/dir.png", undefined),
    ).rejects.toThrow("not a regular file");
  });

  it("refuses a file above the preview cap", async () => {
    const files = new Map<string, FakeFile>([
      ["/big.png", { bytes: new Uint8Array(MAX_PRESENTED_IMAGE_BYTES + 1) }],
    ]);
    await expect(
      readPresentedImage(fakeFs(files), "/big.png", undefined),
    ).rejects.toThrow(`larger than ${MAX_PRESENTED_IMAGE_BYTES} bytes`);
  });
});

describe("sandboxManager.readImage", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function makeManager(
    fs: FileSystem,
    agent: Agent | undefined,
  ): { manager: SandboxManager; initiators: Agent[] } {
    const backend = new FakeBackend();
    const ctx = new Context();
    ctx.provide("fs", fs);
    const initiators: Agent[] = [];
    ctx.provide("agents", {
      withInitiator: <T>(initiated: Agent, operation: () => T): T => {
        initiators.push(initiated);
        return operation();
      },
    });
    const manager = new SandboxManager(
      ctx,
      {
        profiles: { standard: { backend: "docker" } },
        stateDir: directory,
        repository: "https://github.com/example/public.git",
        idleMs: 60_000,
        expiresAfterMs: 60_000,
      },
      {
        backends: { standard: backend },
        gateway: gatewayFor(backend),
        agentLookup: () => agent,
      },
    );
    return { manager, initiators };
  }

  it("reads through the session's agent scope", async () => {
    const fs = fakeFs(
      new Map([["/workspace/repository/art.png", { bytes: png }]]),
    );
    const agent = {
      id: "session-one",
      session: { header: { cwd: "/workspace/repository" } },
    } as unknown as Agent;
    const { manager, initiators } = makeManager(fs, agent);

    const image = await manager.readImage(
      "session-one",
      "/workspace/repository/art.png",
    );
    expect(image.mediaType).toBe("image/png");
    expect(initiators).toEqual([agent]);
  });

  it("answers without a sandbox when the session has no live agent", async () => {
    const { manager, initiators } = makeManager(fakeFs(new Map()), undefined);
    await expect(manager.readImage("session-two", "/art.png")).rejects.toThrow(
      "is not live",
    );
    expect(initiators).toEqual([]);
  });
});
