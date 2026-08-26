# Kubernetes reference environment (Milestone 1)

This reference runs one universal DSH runner behind Kubernetes SIG
agent-sandbox. It is intentionally pinned to **agent-sandbox v0.5.4** and its
`agents.x-k8s.io/v1beta1` and `extensions.agents.x-k8s.io/v1beta1` APIs. The
project is pre-1.0; do not assume these manifests work with another release.

## Prerequisites

- Linux or macOS with Docker, `kind`, `kubectl`, and Python 3
- a locally built DSH runner image, or an image the cluster can pull
- the runner must run as UID 1000, serve port 8080, implement `GET /health`,
  and contain `sh` and `cat` for the smoke test

From a blank machine, install Docker, then install
[kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) and
[`kubectl`](https://kubernetes.io/docs/tasks/tools/). From the repository root:

```sh
docker buildx bake dev --load
node provider/dist/cli.js key public > /tmp/dsh-provider.pub

scripts/kas/dev-cluster.sh \
  --runner-image dsh-runner:dev \
  --public-key-file /tmp/dsh-provider.pub \
  --load-runner-image

scripts/kas/smoke-test.sh --namespace dsh-sandbox
scripts/kas/teardown.sh
```

`--load-runner-image` is for an image already present in the local Docker
daemon. Omit it when `--runner-image` names a registry image reachable by the
cluster. `--public-key-file` must be the public half of the key in the
provider's configured state directory. The script creates `kind-dsh-kas`,
installs exactly the v0.5.4 release asset `sandbox-with-extensions.yaml`, waits
for its CRDs and controllers, and applies `deploy/kubernetes`. It is
noninteractive. Use `--name NAME` on both cluster scripts to choose another
kind cluster name.

For an existing cluster, install the pinned controller and apply the manifests
after replacing both placeholders:

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.4/sandbox-with-extensions.yaml
kubectl wait --for=condition=Established \
  crd/sandboxes.agents.x-k8s.io \
  crd/sandboxclaims.extensions.agents.x-k8s.io \
  crd/sandboxtemplates.extensions.agents.x-k8s.io \
  crd/sandboxwarmpools.extensions.agents.x-k8s.io --timeout=120s
kubectl -n agent-sandbox-system wait --for=condition=Available deployment --all --timeout=180s

# Edit DSH_RUNNER_IMAGE_PLACEHOLDER and the public-key PEM first.
kubectl apply -k deploy/kubernetes
kubectl -n dsh-sandbox wait --for=jsonpath='{.status.readyReplicas}'=1 \
  sandboxwarmpool/dsh-universal --timeout=300s
scripts/kas/smoke-test.sh -n dsh-sandbox
```

Do not deploy the placeholder public key in a trusted environment. The template
contains no session-specific environment variables or Secrets. Claim `env` or
`volumeClaimTemplates` overrides force a cold start instead of adopting a warm
Sandbox, so both injection policies are deliberately `Disallowed`.

## Connectivity and isolation

Each Sandbox gets a headless Service (`service: true`). Its runner endpoint is
only available in-cluster at the assigned Sandbox's
**`status.serviceFQDN:8080`**; it is not an ingress or a public URL. The claim's
`status.sandbox.name` identifies that Sandbox. The provider process therefore
needs an in-cluster route or an equivalent private network path.

The template asks the extension controller to manage a default-deny
NetworkPolicy. Ingress allows TCP 8080 only from the `dsh-sandbox` namespace.
The egress allow-list contains DNS to kube-dns (TCP/UDP 53) and HTTPS (TCP 443).
Everything else is denied by a conforming NetworkPolicy CNI. The broad 443 rule
also permits cluster and private addresses on 443, potentially including the
API server; production deployments should replace it with approved CIDRs or an
FQDN-aware CNI policy and adapt DNS labels for their DNS provider. NetworkPolicy
is connectivity control, not a sandbox boundary.

The pod does not mount a service-account token and runs non-root with dropped
capabilities and RuntimeDefault seccomp. The `dsh-provider` Role is namespace
scoped: it manages claims, reads/patches Sandboxes for lifecycle operations,
and reads only the runner public-key ConfigMap. Bind a real provider workload's
ServiceAccount to this Role rather than granting cluster-admin.

The checked-in template uses the cluster's default runtime (normally `runc`) so
it works in kind. `runc` provides container isolation, not a VM security
boundary for hostile code. For gVisor, install and verify a `RuntimeClass` (for
example `gvisor`) on every eligible node, then add
`runtimeClassName: gvisor` under `podTemplate.spec`; plain kind does not provide
it. Use node selectors/tolerations where only some nodes support gVisor.

## Smoke test and lifecycle

Typical output resembles:

```text
Adopted Sandbox/dsh-universal-abc12 in 180ms (under 1s: yes)
Endpoint: dsh-universal-abc12.dsh-sandbox.svc.cluster.local:8080
Suspended: pod removed; PVC/workspace-dsh-universal-abc12 remains
Resumed in 2400ms; workspace sentinel verified
shutdownTime foreground deletion verified
PASS: agent-sandbox warm adoption, suspend/resume persistence, and expiry
```

The test creates unique claims, discovers the underlying Sandbox through
`.status.sandbox.name`, and uses `spec.operatingMode: Suspended` on that
**Sandbox** (there is no `spec.paused`). Suspension removes compute while the
PVC survives; Running recreates the pod and the test verifies a workspace
sentinel. On failure the main claim is intentionally preserved for debugging;
on success it is removed.

Expiry/deletion is terminal and the owned PVC is garbage-collected. A
hibernated PVC survives only while its Sandbox/Claim remain. Suspended or
expired Sandboxes never return to the warm pool. A pool replenishes with a new
Sandbox after adoption; an adopted Sandbox is not recycled.

The v0.5.4 controller normally gives a warm Sandbox and its backing pod the
same name. The runner reads that pod name through the downward API and checks it
against provider tokens. The smoke test verifies this identity rule and fails
closed if a future controller changes it.

## OpenTelemetry

Add standard `OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_EXPORTER`, or
`OTEL_METRICS_EXPORTER` variables to the runner container in the template to
send traces and command-duration metrics to a collector. Their endpoint must
also be allowed by the egress policy. No exporter is started when none of these
variables is set.
