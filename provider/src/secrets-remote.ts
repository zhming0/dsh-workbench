import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry/types";
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteContribution,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

/**
 * Browser CRUD surface for broker secrets. Values flow browser→host only;
 * every method answers with the updated name list, never a value.
 */
interface SandboxSecretsRemote {
  listSecrets(): Promise<RemoteResult<string[]>>;
  setSecret(name: string, value: string): Promise<RemoteResult<string[]>>;
  deleteSecret(name: string): Promise<RemoteResult<string[]>>;
}

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    sandboxSecrets: SandboxSecretsRemote;
  }

  interface TypertRemoteMap {
    "sandboxSecrets/listSecrets": SandboxSecretsRemote["listSecrets"];
    "sandboxSecrets/setSecret": SandboxSecretsRemote["setSecret"];
    "sandboxSecrets/deleteSecret": SandboxSecretsRemote["deleteSecret"];
  }
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("expected a string");
    return value;
  },
};

const namesSchema: TypertSchema<string[]> = {
  parse(value: unknown): string[] {
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string")
    ) {
      throw new TypeError("expected an array of strings");
    }
    return value as string[];
  },
};

function describe(method: string, parameters: string[]): InvocationDescriptor {
  const id = `@zhming0/dsh-workbench#sandboxSecrets/${method}`;
  return {
    id,
    service: "sandboxManager",
    namespace: "sandboxSecrets",
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
    result: { mode: "strict", typeSymbol: `${id}:result`, schema: namesSchema },
  };
}

const descriptors = [
  describe("listSecrets", []),
  describe("setSecret", ["name", "value"]),
  describe("deleteSecret", ["name"]),
];

export const sandboxSecretsHost: TypertContribution = {
  package: "@zhming0/dsh-workbench",
  face: "host",
  schemas: [],
  invocations: descriptors,
  model: { services: [], events: [], objects: [] },
};

export const sandboxSecretsRemote: TypertRemoteContribution = {
  package: "@zhming0/dsh-workbench",
  descriptors,
};
