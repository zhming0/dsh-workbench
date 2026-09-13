# Runner on Kubernetes agent-sandbox

This phase ends at a **sandbox warm pool**: pre-started pods a session claims
instead of waiting for a cold start. The host creates a SandboxClaim per
session and watches the Sandbox behind it; the runner in that pod dials back to
the host's tunnel, and nothing dials in.

This is the supported backend, pinned to
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) **v1.0.2**
(`agents.x-k8s.io/v1beta1`, `extensions.agents.x-k8s.io/v1beta1`). Do not
assume these manifests work with another release.

Install the [control plane](installations-control-plane.md) first. For what the
pieces do and the isolation model, see [`kubernetes.md`](kubernetes.md).

## Prerequisites

- **the pool in the release namespace.** The host's `dsh-provider` Role, the
  tunnel Service, and the names the pool reads all live there, and the chart
  requires every Kubernetes profile to target that namespace.
- **the agent-sandbox controllers**, pinned at v1.0.2, installed below. A
  chart cannot own another project's CRDs, so this is a manual step.
- **nodes that allow a privileged container.** Each sandbox runs a rootless
  Docker daemon sidecar so sessions can build images. To drop it, delete the
  `docker` container and its two `emptyDir` volumes from the template and the
  runner's `DOCKER_HOST` entry; the CLI then reports that no daemon is
  reachable. [`kubernetes.md`](kubernetes.md#docker-inside-a-sandbox) explains
  why it is privileged.

## Install the controllers

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.2/sandbox-with-extensions.yaml
kubectl wait --for=condition=Established \
  crd/sandboxes.agents.x-k8s.io \
  crd/sandboxclaims.extensions.agents.x-k8s.io \
  crd/sandboxtemplates.extensions.agents.x-k8s.io \
  crd/sandboxwarmpools.extensions.agents.x-k8s.io --timeout=120s
kubectl -n agent-sandbox-system wait --for=condition=Available deployment --all --timeout=180s
```

## Apply the sandbox pool

The pool has to land in the release namespace: its template reads the
`dsh-runner-config` ConfigMap and the `dsh-registration-token` Secret the chart
wrote there, and the host's Role and tunnel Service are there too. The base
therefore names no namespace — the placeholder in it is not a namespace any
cluster has, and applying the base as-is fails. Write an overlay:

```yaml
# dsh-runner/kustomization.yaml
namespace: dsh-sandbox
resources:
  - https://github.com/zhming0/dsh-workbench//deploy/kubernetes/runner?ref=<release-tag>
```

```sh
kubectl apply -k dsh-runner

kubectl -n dsh-sandbox wait --for=jsonpath='{.status.readyReplicas}'=1 \
  sandboxwarmpool/dsh-universal --timeout=300s
```

In a checkout, point `resources` at `../deploy/kubernetes/runner` instead of
the remote base.

The base is a `SandboxTemplate` describing the pod a sandbox runs, a
`SandboxWarmPool` keeping some warm, and nothing else. It is static: the
template reads `HOST_URL` and `REGISTRATION_TOKEN` from what the control plane
wrote, so there is no version to keep in sync. Vary it with the usual overlay
fields:

```yaml
patches:
  - target: { kind: SandboxWarmPool, name: dsh-universal }
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 4
```

## Point the host at the pool

```yaml
# dsh-workbench.values.yaml
provider:
  sandboxManager:
    profiles:
      standard:
        backend: kas
        warmPool: dsh-universal
```

```sh
helm upgrade dsh-workbench oci://ghcr.io/zhming0/charts/dsh-workbench \
  --namespace dsh-sandbox \
  --values dsh-workbench.values.yaml
```

Values are the interface for this row: the chart mounts a read-only patch layer
over the seeded settings and restarts the pod when they change. A `kas` profile
that omits `namespace` is rendered with the release namespace, which is where
the pool and the host's Role live.

Then run a session and send a prompt: a warm pod is claimed, the repository is
cloned into it, and the tools run there.

## Several pools

A second pool is a second template and warm-pool pair plus a second profile.
The usual reason is size: copy the two files in
[`deploy/kubernetes/runner`](../deploy/kubernetes/runner) under a new name,
change the container resources and the volume request, add them to your
kustomization, and list both profiles:

```yaml
- id: sandbox-manager
  config:
    defaultProfile: standard
    profiles:
      standard:
        backend: kas
        warmPool: dsh-universal
      large:
        backend: kas
        warmPool: dsh-large
```

The same works for a structurally different pool — gVisor, custom tolerations,
a different security context. The cluster owns every template; a session picks
among the pools you published and nothing else.

## Next

[`credentials.md`](credentials.md) gives sessions their credentials,
`GITHUB_TOKEN` first.
