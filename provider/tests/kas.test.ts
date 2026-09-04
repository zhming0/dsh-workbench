import type { CustomObjectsApi } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import { KasBackend, testing as kasTesting } from "../src/backends/kas.js";

describe("kubernetes backend", () => {
  it("derives stable claim names", () => {
    expect(kasTesting.claimNameFor("session one")).toMatch(
      /^dsh-[a-f0-9]{20}$/,
    );
  });

  it("can retry a Kubernetes wake after expiry was already cleared", async () => {
    const patches: Array<{ plural: string; body: unknown }> = [];
    const api = {
      async getNamespacedCustomObject(request: { plural: string }) {
        return request.plural === "sandboxclaims"
          ? {
              spec: {},
              status: { sandbox: { name: "sandbox-one" } },
            }
          : {
              status: {
                conditions: [{ type: "Ready", status: "True" }],
              },
            };
      },
      async patchNamespacedCustomObject(request: {
        plural: string;
        body: unknown;
      }) {
        patches.push(request);
        return {};
      },
    } as unknown as CustomObjectsApi;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "test" },
      api,
    );

    const result = await backend.wake({
      claimName: "claim-one",
      sandboxId: "sandbox-one",
    });

    expect(result).toEqual({
      sandboxId: "sandbox-one",
      reference: { claimName: "claim-one", sandboxId: "sandbox-one" },
    });
    expect(patches).toEqual([
      {
        group: "agents.x-k8s.io",
        version: "v1beta1",
        namespace: "test",
        plural: "sandboxes",
        name: "sandbox-one",
        body: [{ op: "add", path: "/spec/operatingMode", value: "Running" }],
      },
    ]);
  });

  it("provisions a Kubernetes sandbox once its claim is assigned", async () => {
    const reads: string[] = [];
    const claims: Array<{ body: { spec: unknown } }> = [];
    const api = {
      async createNamespacedCustomObject(request: { body: { spec: unknown } }) {
        claims.push(request);
        return {};
      },
      async getNamespacedCustomObject(request: { plural: string }) {
        reads.push(request.plural);
        return request.plural === "sandboxclaims"
          ? {
              status: {
                sandbox: { name: "sandbox-one" },
                conditions: [{ type: "Ready", status: "True" }],
              },
            }
          : {
              status: {
                conditions: [{ type: "Ready", status: "True" }],
              },
            };
      },
    } as unknown as CustomObjectsApi;
    const backend = new KasBackend(
      { namespace: "test", warmPool: "dsh-large" },
      api,
    );

    const result = await backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });

    expect(result).toEqual({
      sandboxId: "sandbox-one",
      reference: {
        claimName: kasTesting.claimNameFor("session-one"),
        sandboxId: "sandbox-one",
      },
    });
    expect(reads).toEqual(["sandboxclaims", "sandboxes"]);
    expect(claims.map((claim) => claim.body.spec)).toEqual([
      { warmPoolRef: { name: "dsh-large" } },
    ]);
  });
});
