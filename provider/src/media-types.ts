/**
 * Image file extensions the Web chat can preview inline, shared by the host
 * read and the browser component so both agree on what counts as an image.
 *
 * @module @zhming0/dsh-workbench/media-types
 */

/** Media type by lower-case extension, for files a browser renders as an image. */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

/**
 * Media type for a path the chat can preview, or undefined for anything else.
 * The extension decides: file signatures are not read on this path.
 * @param path - model-authored path, absolute or relative.
 * @returns the image media type, or undefined when the extension is not one.
 */
export function imageMediaType(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    return undefined;
  }
  return IMAGE_MEDIA_TYPES[path.slice(dot).toLowerCase()];
}

/**
 * Trailing path segment, for a caption or an accessible name.
 * @param path - slash- or backslash-separated path.
 * @returns the final segment, or the whole string when separator-free.
 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at === -1 ? path : path.slice(at + 1);
}
