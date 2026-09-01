import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

export interface InstructionWorkspaceView {
  repositoryUrl: string;
  title: string;
  content: string;
}

export interface InstructionSettingsView {
  global: string;
  workspaces: InstructionWorkspaceView[];
}

/** The namespace map declaration lives in remote-contributions.ts. */
export interface SandboxInstructionsRemote {
  getInstructions(): Promise<RemoteResult<InstructionSettingsView>>;
  setGlobalInstructions(
    content: string,
  ): Promise<RemoteResult<InstructionSettingsView>>;
  setWorkspaceInstructions(
    repositoryUrl: string,
    content: string,
  ): Promise<RemoteResult<InstructionSettingsView>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("expected a string");
    return value;
  },
};

const settingsSchema: TypertSchema<InstructionSettingsView> = {
  parse(value: unknown): InstructionSettingsView {
    if (
      typeof value !== "object" ||
      value === null ||
      !("global" in value) ||
      typeof value.global !== "string" ||
      !("workspaces" in value) ||
      !Array.isArray(value.workspaces) ||
      value.workspaces.some(
        (entry) =>
          typeof entry !== "object" ||
          entry === null ||
          !("repositoryUrl" in entry) ||
          typeof entry.repositoryUrl !== "string" ||
          !("title" in entry) ||
          typeof entry.title !== "string" ||
          !("content" in entry) ||
          typeof entry.content !== "string",
      )
    ) {
      throw new TypeError("expected an instruction settings view");
    }
    return value as InstructionSettingsView;
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
    result: {
      mode: "strict",
      typeSymbol: `${id}:result`,
      schema: settingsSchema,
    },
  };
}

export const sandboxInstructionsDescriptors: InvocationDescriptor[] = [
  describe("getInstructions", []),
  describe("setGlobalInstructions", ["content"]),
  describe("setWorkspaceInstructions", ["repositoryUrl", "content"]),
];
