import { useEffect, useState } from "react";

// Type-only imports for the declaration merges that define the
// `conversation.chat.turnTail` slot key and the session standard props.
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";

import type { PresentedImageBytes } from "../media-remote.js";
import { basename } from "../media-types.js";
import type { PresentedImageRef } from "./presented-images.js";

export interface PresentedImagesActions {
  readImage: (sessionId: string, path: string) => Promise<PresentedImageBytes>;
}

type PresentedImagesProps = PropsRuntime<"conversation.chat.turnTail"> &
  PresentedImagesActions & { matched: readonly PresentedImageRef[] };

/**
 * Inline previews for the image files the model declared with `present` in the
 * closing turn. The bytes come from the session's sandbox through the host
 * remote; a session whose agent is gone shows the caption instead, because the
 * preview never wakes a sandbox.
 */
export function PresentedImages({
  matched,
  sessionId,
  readImage,
}: PresentedImagesProps) {
  const id = String(sessionId);
  return (
    <div
      data-testid="dsh-workbench-presented-images"
      style={{ display: "grid", gap: 10, marginTop: 16 }}
    >
      {matched.map((file) => (
        <PresentedImage
          key={`${file.seq}:${file.index}`}
          sessionId={id}
          file={file}
          readImage={readImage}
        />
      ))}
    </div>
  );
}

type PresentedImageProps = {
  sessionId: string;
  file: PresentedImageRef;
  readImage: PresentedImagesActions["readImage"];
};

/** One preview: the image when it loads, its name when it cannot. */
function PresentedImage({ sessionId, file, readImage }: PresentedImageProps) {
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const caption = file.description ?? basename(file.path);

  useEffect(() => {
    let cancelled = false;
    setSource(undefined);
    setFailed(false);
    readImage(sessionId, file.path).then(
      (image) => {
        if (!cancelled) {
          setSource(`data:${image.mediaType};base64,${image.data}`);
        }
      },
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, file.path, readImage]);

  if (failed) {
    return (
      <span style={{ fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }}>
        {caption} — preview unavailable
      </span>
    );
  }
  if (source === undefined) {
    return (
      <span style={{ fontSize: 13, color: "var(--dsw-alias-label-tertiary)" }}>
        Loading {caption}…
      </span>
    );
  }
  return (
    <figure
      style={{ margin: 0, display: "grid", gap: 6, justifyItems: "start" }}
    >
      <img
        src={source}
        alt={caption}
        style={{
          display: "block",
          maxWidth: "100%",
          maxHeight: 420,
          borderRadius: 12,
          border: "0.5px solid var(--dsw-alias-border-l1)",
        }}
      />
      <figcaption
        style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}
      >
        {caption}
      </figcaption>
    </figure>
  );
}
