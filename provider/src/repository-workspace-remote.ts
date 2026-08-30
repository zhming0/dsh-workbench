import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

/** The namespace map declaration lives in remote-contributions.ts. */
export interface RepositoryWorkspaceRemote {
  createRepositoryWorkspace(
    repositoryUrl: string,
  ): Promise<RemoteResult<string>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("expected a string");
    return value;
  },
};

const descriptor: InvocationDescriptor = {
  id: "@zhming0/dsh-workbench#sandboxManager/createRepositoryWorkspace",
  service: "sandboxManager",
  namespace: "sandboxManager",
  method: "createRepositoryWorkspace",
  invocation: { kind: "direct" },
  parameters: [
    {
      name: "repositoryUrl",
      wire: "repositoryUrl",
      source: "json",
      codec: {
        mode: "strict",
        typeSymbol:
          "@zhming0/dsh-workbench#sandboxManager/createRepositoryWorkspace:repositoryUrl",
        schema: stringSchema,
      },
    },
  ],
  result: {
    mode: "strict",
    typeSymbol:
      "@zhming0/dsh-workbench#sandboxManager/createRepositoryWorkspace:result",
    schema: stringSchema,
  },
};

export const repositoryWorkspaceDescriptors: InvocationDescriptor[] = [
  descriptor,
];
