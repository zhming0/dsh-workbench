/**
 * Host read of one presented image for the Web chat's inline preview.
 *
 * The browser asks for a path the model declared with `present`. The path is
 * resolved through the composed filesystem provider, so a sandboxed session
 * reads its own workspace without the browser learning host paths. The caller
 * must already run inside the session's agent scope: `ctx.fs` picks the runner
 * through the initiator, and a request outside it has no sandbox to read.
 *
 * @module @zhming0/dsh-workbench/presented-image
 */

import type { FileSystem } from "@deepseek-ai/dsh-fs";

import { imageMediaType } from "./media-types.js";

/**
 * Largest image sent to the browser for one preview. Base64 costs a third on
 * top of this, and the bytes cross the RPC carrier in one frame; a bigger file
 * still reads through the file tools, it just gets no inline preview.
 */
export const MAX_PRESENTED_IMAGE_BYTES = 8 * 1024 * 1024;

/** One previewable image, encoded for the browser. */
export interface PresentedImage {
  /** Path the filesystem provider resolved, for diagnostics and captions. */
  path: string;
  mediaType: string;
  byteLength: number;
  /** Base64-encoded file bytes. */
  data: string;
}

/**
 * Read one presented image through a filesystem provider.
 * @param fs - the session's composed filesystem.
 * @param path - model-authored path, absolute or relative to `cwd`.
 * @param cwd - session working directory for a relative path.
 * @param signal - caller cancellation.
 * @returns the image bytes and their media type.
 * @throws when the extension is not previewable, the file is missing or not a
 * regular file, or it exceeds {@link MAX_PRESENTED_IMAGE_BYTES}.
 */
export async function readPresentedImage(
  fs: FileSystem,
  path: string,
  cwd: string | undefined,
  signal?: AbortSignal,
): Promise<PresentedImage> {
  const mediaType = imageMediaType(path);
  if (mediaType === undefined) {
    throw new Error(`cannot preview "${path}": not an image file`);
  }
  const target = await fs.resolve(path, {
    ...(cwd === undefined ? {} : { cwd }),
    ...(signal === undefined ? {} : { signal }),
  });
  const info = await fs.stat(target, signal);
  if (info === undefined) {
    throw new Error(`cannot read "${path}": not found`);
  }
  if (info.type !== "file") {
    throw new Error(`cannot read "${path}": not a regular file`);
  }
  if (info.size !== undefined && info.size > MAX_PRESENTED_IMAGE_BYTES) {
    throw new Error(
      `cannot read "${path}": larger than ${MAX_PRESENTED_IMAGE_BYTES} bytes`,
    );
  }
  const bytes = await fs.readBytes(target, signal, MAX_PRESENTED_IMAGE_BYTES);
  return {
    path: target.displayPath,
    mediaType,
    byteLength: bytes.byteLength,
    data: Buffer.from(bytes).toString("base64"),
  };
}
