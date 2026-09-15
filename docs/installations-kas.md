# Runner on Kubernetes agent-sandbox

This phase ends at a **sandbox warm pool**: pre-started pods a session claims
instead of waiting for a cold start. The control plane creates a SandboxClaim per
session and watches the Sandbox behind it; the runner in that pod dials back to
the control plane's tunnel, and nothing dials in.

This is the supported backend, pinned to
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) **v1.0.2**
(`agents.x-k8s.io/v1beta1`, `extensions.agents.x-k8s.io/v1beta1`). Do not
assume these manifests work with another release.

Install the [control plane](installations-control-plane.md) first. For what the
pieces do and the isolation model, see [`kubernetes.md`](kubernetes.md).

## Prerequisites

- **the pool in the release namespace.** The control plane's `dsh-yawn-control-plane` Role, the
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
`dsh-yawn-runner-config` ConfigMap and the `dsh-yawn-registration-token` Secret the chart
wrote there, and the control plane's Role and tunnel Service are there too. The base
therefore names no namespace — the placeholder in it is not a namespace any
cluster has, and applying the base as-is fails. Write an overlay:

```yaml
# dsh-yawn-runner/kustomization.yaml
namespace: dsh-yawn
resources:
  - https://github.com/zhming0/dsh-yawn//deploy/kubernetes/runner?ref=<release-tag>
images:
  - name: ghcr.io/zhming0/dsh-yawn-runner
    newTag: <release-tag>
```

```sh
kubectl apply -k dsh-yawn-runner

kubectl -n dsh-yawn wait --for=jsonpath='{.status.readyReplicas}'=1 \
  sandboxwarmpool/dsh-yawn-universal --timeout=300s
```

In a checkout, point `resources` at `../deploy/kubernetes/runner` instead of
the remote base.

Substitute one concrete version for both `<release-tag>` placeholders: the ref
and the image tag have to name the same release. The base names the runner
image without a tag, because the image is one artifact for every release and
which version a cluster runs is the version of the control plane it registers
with — `kubectl get deploy dsh-yawn-control-plane -o jsonpath='{.spec.template.spec.containers[0].image}'`
prints the one the chart installed. Nothing checks it at install time: a warm
pod from another version fails when it dials the tunnel.

The base is a `SandboxTemplate` describing the pod a sandbox runs, a
`SandboxWarmPool` keeping some warm, and nothing else. Apart from the runner
tag, it is static: the template reads `DSH_YAWN_CONTROL_PLANE_URL` and
`DSH_YAWN_REGISTRATION_TOKEN` from what the control plane wrote, and its
tunnel egress rule selects the control-plane pod in the pool's own namespace,
so the `namespace:` above is the only place a namespace appears.

## Configure the pool

An overlay varies the pool with JSON patches. **Address a list as a whole,
never by index.** Kubernetes sees a custom resource's list as one value, so an
index is only a position in the base revision you vendored; a release that
reorders an entry moves it.

```yaml
patches:
  - target: { kind: SandboxWarmPool, name: dsh-yawn-universal }
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 4
  - target: { kind: SandboxTemplate, name: dsh-yawn-universal }
    patch: |-
      # Replacing the whole list restates every part you keep, `accessModes`
      # included.
      - op: replace
        path: /spec/volumeClaimTemplates
        value:
          - metadata:
              name: workspace
            spec:
              accessModes: [ReadWriteOnce]
              storageClassName: rook-ceph-block
              resources:
                requests:
                  storage: 5Gi
      # Pod resources: one ceiling the kubelet splits across the containers.
      - op: add
        path: /spec/podTemplate/spec/resources
        value:
          requests: {cpu: 200m, memory: 512Mi}
          limits: {cpu: "4", memory: 6Gi}
```

Egress is a list as well: `/spec/networkPolicy/egress/-` appends a rule, and
replacing `/spec/networkPolicy/egress` as a whole changes the existing ones.
The checked-in list is the tunnel to the control plane (TCP 8081), DNS to
kube-dns (TCP/UDP 53), and HTTP and HTTPS (80 and 443); narrow the 80/443 rule
in production.
`podTemplate.spec.volumes`, which carries the Docker data mount's `emptyDir`
sizeLimit, takes the same whole-list patch.

An overlay that patched the tunnel rule's `namespaceSelector` (a path like
`/spec/networkPolicy/egress/0/to/0/namespaceSelector/...`) must delete that op
when it bumps `?ref=`: the path is gone, and the render fails until then.

## Point the control plane at the pool

```yaml
# dsh-yawn.values.yaml
provider:
  sandboxManager:
    profiles:
      standard:
        backend: kas
        warmPool: dsh-yawn-universal
```

```sh
helm upgrade dsh-yawn-control-plane oci://ghcr.io/zhming0/charts/dsh-yawn \
  --namespace dsh-yawn \
  --values dsh-yawn.values.yaml
```

Values are the interface for this row: the chart mounts a read-only patch layer
over the seeded settings and restarts the pod when they change. A `kas` profile
that omits `namespace` is rendered with the release namespace, which is where
the pool and the control plane's Role live.

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
        warmPool: dsh-yawn-universal
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
