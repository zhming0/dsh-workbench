import type {
  InvocationDescriptor,
  RemoteResult,
  TypertSchema,
} from "@deepseek-ai/dsh-typert-protocol";

/** What the host knows about a session's sandbox without asking it anything. */
export interface SandboxHostFacts {
  backend: string;
  profile: string;
  /** The profile's runner image, when its backend provisions one from an image. */
  image?: string;
  /** Absent for a checkpointed session, whose sandbox was destroyed. */
  sandboxId?: string;
  state: "running" | "hibernated" | "checkpointed";
  repositoryUrl: string;
  startedAt: string;
  /** Present once the sandbox has a deletion deadline: hibernated or checkpointed. */
  expiresAt?: string;
}

/**
 * What the sandbox machine says about itself. Absent whenever no live runner
 * is attached, which includes every sandbox that is not running: reading a
 * status never provisions, wakes, or counts as activity, so a hibernated
 * session answers with its host facts alone.
 */
export interface SandboxLiveFacts {
  hostname: string;
  osName: string;
  kernelVersion: string;
  architecture: string;
  cpuCount: number;
  memoryTotalBytes: number;
  workspaceDiskUsedBytes: number;
  workspaceDiskTotalBytes: number;
  filesystemDiskUsedBytes: number;
  filesystemDiskTotalBytes: number;
  uptimeSeconds: number;
}

export interface SandboxStatusView {
  /** Absent until the sandbox has been provisioned. */
  sandbox?: SandboxHostFacts;
  live?: SandboxLiveFacts;
}

/** The namespace map declaration lives in remote-contributions.ts. */
export interface SandboxStatusRemote {
  getSandboxStatus(sessionId: string): Promise<RemoteResult<SandboxStatusView>>;
}

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== "string") {
      throw new TypeError("expected a string");
    }
    return value;
  },
};

const hostFactsSchema: TypertSchema<SandboxHostFacts> = {
  parse(value: unknown): SandboxHostFacts {
    const facts = value as Partial<SandboxHostFacts> | null;
    if (
      typeof facts !== "object" ||
      facts === null ||
      typeof facts.backend !== "string" ||
      typeof facts.profile !== "string" ||
      (facts.image !== undefined && typeof facts.image !== "string") ||
      (facts.sandboxId !== undefined && typeof facts.sandboxId !== "string") ||
      (facts.state !== "running" &&
        facts.state !== "hibernated" &&
        facts.state !== "checkpointed") ||
      typeof facts.repositoryUrl !== "string" ||
      typeof facts.startedAt !== "string" ||
      (facts.expiresAt !== undefined && typeof facts.expiresAt !== "string")
    ) {
      throw new TypeError("expected sandbox host facts");
    }
    return facts as SandboxHostFacts;
  },
};

const liveFactsSchema: TypertSchema<SandboxLiveFacts> = {
  parse(value: unknown): SandboxLiveFacts {
    const facts = value as Partial<SandboxLiveFacts> | null;
    if (
      typeof facts !== "object" ||
      facts === null ||
      typeof facts.hostname !== "string" ||
      typeof facts.osName !== "string" ||
      typeof facts.kernelVersion !== "string" ||
      typeof facts.architecture !== "string" ||
      !isNonNegativeNumber(facts.cpuCount) ||
      !isNonNegativeNumber(facts.memoryTotalBytes) ||
      !isNonNegativeNumber(facts.workspaceDiskUsedBytes) ||
      !isNonNegativeNumber(facts.workspaceDiskTotalBytes) ||
      !isNonNegativeNumber(facts.filesystemDiskUsedBytes) ||
      !isNonNegativeNumber(facts.filesystemDiskTotalBytes) ||
      !isNonNegativeNumber(facts.uptimeSeconds)
    ) {
      throw new TypeError("expected sandbox live facts");
    }
    return facts as SandboxLiveFacts;
  },
};

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const viewSchema: TypertSchema<SandboxStatusView> = {
  parse(value: unknown): SandboxStatusView {
    const view = value as SandboxStatusView | null;
    if (typeof view !== "object" || view === null) {
      throw new TypeError("expected a sandbox status view");
    }
    if (view.sandbox !== undefined) {
      hostFactsSchema.parse(view.sandbox);
    }
    if (view.live !== undefined) {
      liveFactsSchema.parse(view.live);
    }
    return view;
  },
};

export const sandboxStatusDescriptors: InvocationDescriptor[] = [
  {
    id: "@zhming0/dsh-yawn#sandboxManager/getSandboxStatus",
    service: "sandboxManager",
    namespace: "sandboxManager",
    method: "getSandboxStatus",
    invocation: { kind: "direct" },
    parameters: ["sessionId"].map((name) => ({
      name,
      wire: name,
      source: "json" as const,
      codec: {
        mode: "strict" as const,
        typeSymbol: `@zhming0/dsh-yawn#sandboxManager/getSandboxStatus:${name}`,
        schema: stringSchema,
      },
    })),
    result: {
      mode: "strict",
      typeSymbol: "@zhming0/dsh-yawn#sandboxManager/getSandboxStatus:result",
      schema: viewSchema,
    },
  },
];
