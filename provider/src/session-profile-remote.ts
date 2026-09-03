import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

export interface SessionProfileOption {
  name: string;
  backend: string;
}

export interface SessionProfileView {
  profiles: SessionProfileOption[];
  selected: string;
  /** True once the session has a sandbox; the profile can no longer change. */
  locked: boolean;
}

/** The namespace map declaration lives in remote-contributions.ts. */
export interface SessionProfileRemote {
  getSessionProfile(
    sessionId: string,
  ): Promise<RemoteResult<SessionProfileView>>;
  setSessionProfile(
    sessionId: string,
    profile: string,
  ): Promise<RemoteResult<SessionProfileView>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("expected a string");
    }
    return value;
  },
};

const viewSchema: TypertSchema<SessionProfileView> = {
  parse(value: unknown): SessionProfileView {
    if (
      typeof value !== "object" ||
      value === null ||
      !("profiles" in value) ||
      !Array.isArray(value.profiles) ||
      value.profiles.some(
        (entry: unknown) =>
          typeof entry !== "object" ||
          entry === null ||
          !("name" in entry) ||
          typeof entry.name !== "string" ||
          !("backend" in entry) ||
          typeof entry.backend !== "string",
      ) ||
      !("selected" in value) ||
      typeof value.selected !== "string" ||
      !("locked" in value) ||
      typeof value.locked !== "boolean"
    ) {
      throw new TypeError("expected a session profile view");
    }
    return value as SessionProfileView;
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
    result: { mode: "strict", typeSymbol: `${id}:result`, schema: viewSchema },
  };
}

export const sessionProfileDescriptors: InvocationDescriptor[] = [
  describe("getSessionProfile", ["sessionId"]),
  describe("setSessionProfile", ["sessionId", "profile"]),
];
