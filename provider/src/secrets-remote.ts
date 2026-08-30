import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

/**
 * Browser CRUD surface for broker secrets. Values flow browser→host only;
 * every method answers with the updated name list, never a value.
 * The namespace map declaration lives in remote-contributions.ts.
 */
export interface SandboxSecretsRemote {
  listSecrets(): Promise<RemoteResult<string[]>>;
  setSecret(name: string, value: string): Promise<RemoteResult<string[]>>;
  deleteSecret(name: string): Promise<RemoteResult<string[]>>;
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
  const id = `@zhming0/dsh-workbench#sandboxManager/${method}`;
  return {
    id,
    // The gateway accepts one wire namespace per host service, so the secret
    // methods live in the manager's own namespace.
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
    result: { mode: "strict", typeSymbol: `${id}:result`, schema: namesSchema },
  };
}

export const sandboxSecretsDescriptors: InvocationDescriptor[] = [
  describe("listSecrets", []),
  describe("setSecret", ["name", "value"]),
  describe("deleteSecret", ["name"]),
];
