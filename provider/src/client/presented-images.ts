/**
 * Conversation Definition and turn-tail selector for images the model
 * declared with `present`.
 *
 * The stock deliverables row that would render those declarations is disabled
 * in this bundle, so the files land in the Session log with nothing on screen.
 * This Definition folds the declarations into Turn data, and the selector
 * claims the turn tail of a turn whose declarations include an image file, so
 * the chat can render a preview. Only declarations before the closing reply
 * count, and the latest declaration of a path wins — the same rules the stock
 * row uses.
 *
 * @module @zhming0/dsh-workbench/client/presented-images
 */

import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationLocationData,
  ConversationLocationDataScope,
  ConversationStartMatch,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { TurnTailOwnerProps } from "@deepseek-ai/dsh-client-ui-chat/client";
import type { PresentedFile } from "@deepseek-ai/dsh-tool-present/types";

import { imageMediaType } from "../media-types.js";

/** Turn-data key this Definition publishes under. */
export const PRESENTED_IMAGES_KEY = "workbench-presented-images";

/** One image declaration with the Session coordinates it was read from. */
export interface PresentedImageRef extends PresentedFile {
  /** Sequence of the `deliverables/presented` event carrying the declaration. */
  readonly seq: number;
  /** Index of the file inside that event's list. */
  readonly index: number;
}

/** Immutable presented-image facts published against one Turn. */
export interface PresentedImagesTurnData {
  readonly images: readonly PresentedImageRef[];
}

declare module "@deepseek-ai/dsh-client-ui-conversation/client" {
  interface ConversationTurnDataMap {
    /** Image files declared in this Turn, in declaration order. */
    "workbench-presented-images": PresentedImagesTurnData;
  }
}

interface PresentedImagesState extends PresentedImagesTurnData {
  readonly turn: number;
}

/** @returns whether durable data is shaped like a `deliverables/presented` payload. */
function isPresentedData(
  value: unknown,
): value is { turn: number; files: readonly unknown[] } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { turn, files } = value as { turn?: unknown; files?: unknown };
  return (
    typeof turn === "number" &&
    Number.isSafeInteger(turn) &&
    turn >= 1 &&
    Array.isArray(files)
  );
}

/** @returns whether one durable declaration names a path. */
function isPresentedFile(value: unknown): value is PresentedFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { path, description } = value as {
    path?: unknown;
    description?: unknown;
  };
  return (
    typeof path === "string" &&
    path.trim().length > 0 &&
    (description === undefined || typeof description === "string")
  );
}

/** Turn-local accumulator over `deliverables/presented`; publishes no view Node. */
export const presentedImagesDefinition: ConversationNodeDefinition<PresentedImagesState> =
  {
    kind: "workbench-presented-images",
    match(event) {
      if (event.type === "turn/start") {
        return { id: String(event.data.turn), role: "start" };
      }
      if (
        event.type !== "deliverables/presented" ||
        !isPresentedData(event.data)
      ) {
        return null;
      }
      return { id: String(event.data.turn), role: "update" };
    },
    start(_context, match: ConversationStartMatch) {
      if (match.event.type !== "turn/start") {
        throw new Error("presented images start requires turn/start");
      }
      return { turn: match.event.data.turn, images: [] };
    },
    update(
      context: ConversationNodeContext<PresentedImagesState> & {
        readonly state: PresentedImagesState;
      },
      match: ConversationMatch,
    ) {
      if (match.event.type !== "deliverables/presented") {
        return context.state;
      }
      const { files } = match.event.data;
      const images: PresentedImageRef[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (isPresentedFile(file)) {
          images.push({ ...file, seq: match.event.seq, index });
        }
      }
      return images.length === 0
        ? context.state
        : { ...context.state, images: [...context.state.images, ...images] };
    },
    buildLocationData(
      context: ConversationNodeContext<PresentedImagesState>,
      scope: ConversationLocationDataScope,
      previous: ConversationLocationData | null,
    ): ConversationLocationData | null {
      if (scope !== "turn" || context.state === undefined) {
        return null;
      }
      const value: PresentedImagesTurnData = { images: context.state.images };
      if (
        previous?.kind === "turn" &&
        previous.turn === context.state.turn &&
        previous.key === PRESENTED_IMAGES_KEY &&
        previous.value.images === value.images
      ) {
        return previous;
      }
      return {
        kind: "turn",
        turn: context.state.turn,
        key: PRESENTED_IMAGES_KEY,
        value,
      };
    },
  };

/**
 * Claim the turn-tail chain when the closing turn declared an image file.
 * @param owner - closing turn and sequence.
 * @returns the images to preview, or null to leave the chain empty.
 */
export function selectPresentedImages(
  owner: TurnTailOwnerProps,
): readonly PresentedImageRef[] | null {
  const latest = new Map<string, PresentedImageRef>();
  for (const image of owner.turn.data.get(PRESENTED_IMAGES_KEY)?.images ?? []) {
    if (image.seq < owner.seq) {
      latest.set(image.path, image);
    }
  }
  const images = [...latest.values()].filter(
    (image) => imageMediaType(image.path) !== undefined,
  );
  return images.length === 0 ? null : images;
}
