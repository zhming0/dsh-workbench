import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry/types";
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteContribution,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

interface RepositoryWorkspaceRemote {
  createRepositoryWorkspace(
    repositoryUrl: string,
  ): Promise<RemoteResult<string>>;
}

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    sandboxManager: RepositoryWorkspaceRemote;
  }

  interface TypertRemoteMap {
    "sandboxManager/createRepositoryWorkspace": RepositoryWorkspaceRemote["createRepositoryWorkspace"];
  }
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

export const repositoryWorkspaceHost: TypertContribution = {
  package: "@zhming0/dsh-workbench",
  face: "host",
  schemas: [],
  invocations: [descriptor],
  model: { services: [], events: [], objects: [] },
};

export const repositoryWorkspaceRemote: TypertRemoteContribution = {
  package: "@zhming0/dsh-workbench",
  descriptors: [descriptor],
};
