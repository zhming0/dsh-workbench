import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationStartMatch,
  TurnLocation,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { TurnTailOwnerProps } from "@deepseek-ai/dsh-client-ui-chat/client";
import { describe, expect, it } from "vitest";

import {
  PRESENTED_IMAGES_KEY,
  presentedImagesDefinition,
  selectPresentedImages,
  type PresentedImageRef,
} from "../src/client/presented-images.js";

const definition = presentedImagesDefinition;

function startTurn(turn: number) {
  return definition.start(
    {} as ConversationNodeContext<never>,
    {
      event: { type: "turn/start", data: { turn } },
    } as unknown as ConversationStartMatch,
    {} as never,
  );
}

function present(
  state: ReturnType<typeof startTurn>,
  turn: number,
  seq: number,
  files: unknown[],
) {
  return definition.update?.(
    { state } as ConversationNodeContext<never> & { state: never },
    {
      event: { type: "deliverables/presented", data: { turn, files }, seq },
    } as unknown as ConversationMatch,
  );
}

function owner(images: readonly PresentedImageRef[], seq: number) {
  return {
    turn: {
      data: {
        get: (key: string) =>
          key === PRESENTED_IMAGES_KEY ? { images } : undefined,
      },
    },
    seq,
    openFile: () => {},
  } as unknown as TurnTailOwnerProps & TurnLocation;
}

describe("presentedImagesDefinition", () => {
  it("starts on a turn and folds declarations into turn data", () => {
    const state = present(
      present(startTurn(3), 3, 4, [{ path: "/w/a.png" }]),
      3,
      6,
      [{ path: "/w/b.PNG", description: "chart" }, { path: "  " }, "nope"],
    );

    expect(
      definition.buildLocationData?.({ state } as never, "turn", null),
    ).toEqual({
      kind: "turn",
      turn: 3,
      key: PRESENTED_IMAGES_KEY,
      value: {
        images: [
          { path: "/w/a.png", seq: 4, index: 0 },
          { path: "/w/b.PNG", description: "chart", seq: 6, index: 0 },
        ],
      },
    });
  });

  it("publishes nothing for steps and reuses an unchanged value", () => {
    const state = startTurn(1);
    expect(
      definition.buildLocationData?.({ state } as never, "step", null),
    ).toBeNull();

    const first = definition.buildLocationData?.(
      { state } as never,
      "turn",
      null,
    );
    expect(first).toBeDefined();
    const again = definition.buildLocationData?.(
      { state } as never,
      "turn",
      first ?? null,
    );
    expect(again).toBe(first);
  });
});

describe("selectPresentedImages", () => {
  const a: PresentedImageRef = { path: "/w/a.png", seq: 4, index: 0 };
  const b: PresentedImageRef = { path: "/w/b.jpg", seq: 5, index: 1 };
  const notes: PresentedImageRef = { path: "/w/notes.txt", seq: 4, index: 1 };

  it("keeps the latest declaration per path and drops non-images", () => {
    const later: PresentedImageRef = {
      path: "/w/a.png",
      description: "final",
      seq: 6,
      index: 0,
    };
    expect(selectPresentedImages(owner([a, notes, later, b], 9))).toEqual([
      later,
      b,
    ]);
  });

  it("ignores declarations at or after the closing reply", () => {
    expect(selectPresentedImages(owner([a], 4))).toBeNull();
  });

  it("declines a turn with no image declarations", () => {
    expect(selectPresentedImages(owner([notes], 9))).toBeNull();
    expect(selectPresentedImages(owner([], 9))).toBeNull();
  });
});
