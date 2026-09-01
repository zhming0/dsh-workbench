import { createHash } from "node:crypto";

import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";

import { SandboxNotFoundError } from "../types.js";
import type {
  BackendReference,
  SandboxBackend,
  SandboxHandle,
  SandboxSpec,
} from "../types.js";

const EXTENSION_GROUP = "extensions.agents.x-k8s.io";
const CORE_GROUP = "agents.x-k8s.io";
const API_VERSION = "v1beta1";

interface KasReference extends BackendReference {
  claimName: string;
  sandboxId: string;
}

interface ClaimObject {
  spec?: { lifecycle?: unknown };
  status?: {
    sandbox?: { name?: string };
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

interface SandboxObject {
  status?: {
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

export interface KasBackendOptions {
  namespace: string;
  warmPool: string;
  readyTimeoutMs?: number;
  kubeconfig?: string;
}

export class KasBackend implements SandboxBackend {
  readonly name = "kas";
  readonly capabilities = { supportsHibernate: true };
  private readonly api: CustomObjectsApi;
  private readonly readyTimeoutMs: number;

  constructor(
    private readonly options: KasBackendOptions,
    api?: CustomObjectsApi,
  ) {
    if (api === undefined) {
      const config = new KubeConfig();
      if (options.kubeconfig === undefined) config.loadFromDefault();
      else config.loadFromFile(options.kubeconfig);
      this.api = config.makeApiClient(CustomObjectsApi);
    } else {
      this.api = api;
    }
    this.readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
  }

  async provision(spec: SandboxSpec): Promise<SandboxHandle> {
    const claimName = claimNameFor(spec.sessionId);
    try {
      await this.api.createNamespacedCustomObject({
        group: EXTENSION_GROUP,
        version: API_VERSION,
        namespace: this.options.namespace,
        plural: "sandboxclaims",
        body: {
          apiVersion: `${EXTENSION_GROUP}/${API_VERSION}`,
          kind: "SandboxClaim",
          metadata: {
            name: claimName,
            labels: { "dsh/session": safeLabel(spec.sessionId) },
          },
          spec: { warmPoolRef: { name: this.options.warmPool } },
        },
      });
    } catch (error) {
      // The provider may have stopped after creating the claim but before
      // saving its local record. Its deterministic name makes that recoverable.
      if (!isKubernetesStatus(error, 409)) throw error;
    }
    const claim = await this.waitForClaim(claimName);
    const sandboxId = claim.status?.sandbox?.name;
    if (sandboxId === undefined) {
      throw new Error(`SandboxClaim ${claimName} became ready unassigned`);
    }
    await this.waitForSandboxCondition(sandboxId, "Ready");
    return { sandboxId, reference: { claimName, sandboxId } };
  }

  async hibernate(reference: BackendReference): Promise<void> {
    const ref = kasReference(reference);
    try {
      await this.patchSandbox(ref.sandboxId, "Suspended");
      await this.waitForSandboxCondition(ref.sandboxId, "Suspended");
    } catch (error) {
      if (isKubernetesStatus(error, 404)) {
        throw new SandboxNotFoundError(
          `Sandbox ${ref.sandboxId} no longer exists`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async wake(reference: BackendReference): Promise<SandboxHandle> {
    const ref = kasReference(reference);
    try {
      await this.clearExpiry(ref.claimName);
      await this.patchSandbox(ref.sandboxId, "Running");
      await this.waitForSandboxCondition(ref.sandboxId, "Ready");
      return { sandboxId: ref.sandboxId, reference: ref };
    } catch (error) {
      if (isKubernetesStatus(error, 404)) {
        throw new SandboxNotFoundError(
          `SandboxClaim ${ref.claimName} no longer exists`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  async destroy(reference: BackendReference): Promise<void> {
    const ref = kasReference(reference);
    try {
      await this.api.deleteNamespacedCustomObject({
        group: EXTENSION_GROUP,
        version: API_VERSION,
        namespace: this.options.namespace,
        plural: "sandboxclaims",
        name: ref.claimName,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (!isKubernetesNotFound(error)) throw error;
    }
  }

  async expireAt(reference: BackendReference, deadline: Date): Promise<void> {
    const ref = kasReference(reference);
    try {
      await this.api.patchNamespacedCustomObject({
        group: EXTENSION_GROUP,
        version: API_VERSION,
        namespace: this.options.namespace,
        plural: "sandboxclaims",
        name: ref.claimName,
        body: [
          {
            op: "add",
            path: "/spec/lifecycle",
            value: {
              shutdownTime: deadline.toISOString(),
              shutdownPolicy: "DeleteForeground",
            },
          },
        ],
      });
    } catch (error) {
      if (isKubernetesStatus(error, 404)) {
        throw new SandboxNotFoundError(
          `SandboxClaim ${ref.claimName} no longer exists`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  async health(reference: BackendReference): Promise<boolean> {
    const ref = kasReference(reference);
    try {
      const sandbox = (await this.api.getNamespacedCustomObject({
        group: CORE_GROUP,
        version: API_VERSION,
        namespace: this.options.namespace,
        plural: "sandboxes",
        name: ref.sandboxId,
      })) as SandboxObject;
      return conditionIsTrue(sandbox.status?.conditions, "Ready");
    } catch (error) {
      if (isKubernetesStatus(error, 404)) return false;
      throw error;
    }
  }

  private async patchSandbox(
    name: string,
    operatingMode: "Running" | "Suspended",
  ) {
    await this.api.patchNamespacedCustomObject({
      group: CORE_GROUP,
      version: API_VERSION,
      namespace: this.options.namespace,
      plural: "sandboxes",
      name,
      body: [{ op: "add", path: "/spec/operatingMode", value: operatingMode }],
    });
  }

  private getClaim(name: string): Promise<ClaimObject> {
    return this.api.getNamespacedCustomObject({
      group: EXTENSION_GROUP,
      version: API_VERSION,
      namespace: this.options.namespace,
      plural: "sandboxclaims",
      name,
    }) as Promise<ClaimObject>;
  }

  private async clearExpiry(name: string): Promise<void> {
    const claim = await this.getClaim(name);
    if (claim.spec?.lifecycle === undefined) return;
    await this.api.patchNamespacedCustomObject({
      group: EXTENSION_GROUP,
      version: API_VERSION,
      namespace: this.options.namespace,
      plural: "sandboxclaims",
      name,
      body: [{ op: "remove", path: "/spec/lifecycle" }],
    });
  }

  private async waitForClaim(name: string): Promise<ClaimObject> {
    return poll(
      async () => {
        const claim = await this.getClaim(name);
        return conditionIsTrue(claim.status?.conditions, "Ready") &&
          claim.status?.sandbox?.name !== undefined
          ? claim
          : undefined;
      },
      this.readyTimeoutMs,
      `SandboxClaim ${name} did not become ready`,
    );
  }

  private waitForSandboxCondition(
    name: string,
    condition: "Ready" | "Suspended",
  ) {
    return poll(
      async () => {
        const sandbox = (await this.api.getNamespacedCustomObject({
          group: CORE_GROUP,
          version: API_VERSION,
          namespace: this.options.namespace,
          plural: "sandboxes",
          name,
        })) as SandboxObject;
        return conditionIsTrue(sandbox.status?.conditions, condition)
          ? sandbox
          : undefined;
      },
      this.readyTimeoutMs,
      `Sandbox ${name} did not become ${condition.toLowerCase()}`,
    );
  }
}

function kasReference(value: BackendReference): KasReference {
  if (
    typeof value.claimName !== "string" ||
    typeof value.sandboxId !== "string"
  ) {
    throw new Error("invalid Kubernetes agent-sandbox reference");
  }
  return value as KasReference;
}

function claimNameFor(sessionId: string): string {
  return `dsh-${createHash("sha256").update(sessionId).digest("hex").slice(0, 20)}`;
}

function safeLabel(value: string): string {
  return value.length <= 63 &&
    /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value)
    ? value
    : createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function conditionIsTrue(
  conditions: Array<{ type?: string; status?: string }> | undefined,
  type: string,
): boolean {
  return (
    conditions?.some((item) => item.type === type && item.status === "True") ??
    false
  );
}

async function poll<T>(
  operation: () => Promise<T | undefined>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
}

function isKubernetesStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === status
  );
}

function isKubernetesNotFound(error: unknown): boolean {
  return isKubernetesStatus(error, 404);
}

export const testing = {
  claimNameFor,
  conditionIsTrue,
  kasReference,
  safeLabel,
};
