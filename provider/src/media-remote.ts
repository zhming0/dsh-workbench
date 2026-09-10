import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

/** One presented image, encoded for the browser preview. */
export interface PresentedImageBytes {
  /** Path the filesystem provider resolved, for diagnostics and captions. */
  path: string;
  mediaType: string;
  byteLength: number;
  /** Base64-encoded file bytes. */
  data: string;
}

/** The namespace map declaration lives in remote-contributions.ts. */
export interface MediaRemote {
  /**
   * Read one image the model declared with `present` out of the session's
   * sandbox. A session without a live agent cannot be read: the request never
   * provisions or wakes a sandbox.
   */
  readImage(
    sessionId: string,
    path: string,
  ): Promise<RemoteResult<PresentedImageBytes>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("expected a string");
    }
    return value;
  },
};

const imageSchema: TypertSchema<PresentedImageBytes> = {
  parse(value: unknown): PresentedImageBytes {
    if (
      typeof value !== "object" ||
      value === null ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      !("mediaType" in value) ||
      typeof value.mediaType !== "string" ||
      !("byteLength" in value) ||
      typeof value.byteLength !== "number" ||
      !("data" in value) ||
      typeof value.data !== "string"
    ) {
      throw new TypeError("expected presented image bytes");
    }
    return value as PresentedImageBytes;
  },
};

function describe(method: string, parameters: string[]): InvocationDescriptor {
  const id = `@zhming0/dsh-workbench#sandboxManager/${method}`;
  return {
    id,
    service: "sandboxManager",
    namespace: "sandboxManager",
    method,
    invocation: { kind: "direct" },
    parameters: parameters.map((name) => ({
      name,
      wire: name,
      source: "json",
      codec: {
        mode: "strict",
        typeSymbol: `${id}:${name}`,
        schema: stringSchema,
      },
    })),
    result: { mode: "strict", typeSymbol: `${id}:result`, schema: imageSchema },
  };
}

export const mediaDescriptors: InvocationDescriptor[] = [
  describe("readImage", ["sessionId", "path"]),
];
