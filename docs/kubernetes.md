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
docker buildx bake dev host-dev --load

scripts/kas/dev-cluster.sh \
  --runner-image dsh-runner:dev \
  --host-image dsh-host:dev \
  --load-runner-image

scripts/kas/smoke-test.sh --namespace dsh-sandbox
scripts/kas/teardown.sh
```

With `--host-image`, the dsh host itself runs in the cluster and the script
reads the runner public key from its pod. The script applies the raw
manifests, so the dev host runs without the OIDC proxy and is reached over
`kubectl port-forward` — no identity provider needed. To run dsh outside the
cluster instead, omit it and pass the external provider's key:

```sh
node provider/dist/cli.js key public > /tmp/dsh-provider.pub
scripts/kas/dev-cluster.sh \
  --runner-image dsh-runner:dev \
  --public-key-file /tmp/dsh-provider.pub \
  --load-runner-image
```

`--load-runner-image` is for images already present in the local Docker daemon.
Omit it when the images are pullable by the cluster. `--public-key-file` must
be the public half of the key in the provider's configured state directory.
The script creates `kind-dsh-kas`,
installs exactly the v0.5.4 release asset `sandbox-with-extensions.yaml`, waits
for its CRDs and controllers, and applies `deploy/kubernetes`. It is
noninteractive. Use `--name NAME` on both cluster scripts to choose another
kind cluster name.

For an existing cluster, install the pinned controller, create the OIDC
Secret the proxy container reads (see
[`host-oidc.yaml`](../deploy/kubernetes/host-oidc.yaml) — without it the host
pod never becomes Ready), and apply the manifests after replacing both image
placeholders with released tags and `dsh.example.com` with your hostname:

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.4/sandbox-with-extensions.yaml
kubectl wait --for=condition=Established \
  crd/sandboxes.agents.x-k8s.io \
  crd/sandboxclaims.extensions.agents.x-k8s.io \
  crd/sandboxtemplates.extensions.agents.x-k8s.io \
  crd/sandboxwarmpools.extensions.agents.x-k8s.io --timeout=120s
kubectl -n agent-sandbox-system wait --for=condition=Available deployment --all --timeout=180s

kubectl create namespace dsh-sandbox
kubectl -n dsh-sandbox create secret generic dsh-host-oidc \
  --from-literal=OAUTH2_PROXY_OIDC_ISSUER_URL=https://your-idp/realm \
  --from-literal=OAUTH2_PROXY_CLIENT_ID=dsh-host \
  --from-literal=OAUTH2_PROXY_CLIENT_SECRET=… \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"

# Edit DSH_RUNNER_IMAGE_PLACEHOLDER, DSH_HOST_IMAGE_PLACEHOLDER, and
# dsh.example.com in host-oidc.yaml first.
kubectl apply -k deploy/kubernetes
kubectl -n dsh-sandbox rollout status deployment/dsh-host --timeout=300s

# Replace the placeholder public key with the host pod's real key, then let
# the pool recreate warm pods with it (see "The in-cluster dsh host" below).
kubectl -n dsh-sandbox exec deploy/dsh-host -- dsh-workbench key public \
  > /tmp/dsh-provider.pub
kubectl -n dsh-sandbox create configmap dsh-runner-public-key \
  --from-file=public-key.pem=/tmp/dsh-provider.pub \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n dsh-sandbox delete sandbox --all

kubectl -n dsh-sandbox wait --for=jsonpath='{.status.readyReplicas}'=1 \
  sandboxwarmpool/dsh-universal --timeout=300s
scripts/kas/smoke-test.sh -n dsh-sandbox
```

Do not deploy the placeholder public key in a trusted environment. The template
contains no session-specific environment variables or Secrets. Claim `env` or
`volumeClaimTemplates` overrides force a cold start instead of adopting a warm
Sandbox, so both injection policies are deliberately `Disallowed`.

## The in-cluster dsh host

[`50-host.yaml`](../deploy/kubernetes/50-host.yaml) runs the
`ghcr.io/zhming0/dsh-host` distribution image as a single-replica Deployment.
Replace `DSH_HOST_IMAGE_PLACEHOLDER` with a released tag. Its home directory is
the `dsh-host-data` volume, which carries everything durable: dsh sessions and
storages, the seeded `web` profile with your `cordis.patch.yml`, and the
provider's signing key and session records. Deleting the pod loses nothing;
deleting the PVC loses all of it.

The seeded configuration already selects `backend: kas` with this namespace and
warm pool, and the provider talks to the API server with the automounted
`dsh-provider` ServiceAccount token, so the host needs no further wiring. Edit
settings in place — the file is watched, no restart needed:

```sh
kubectl -n dsh-sandbox exec -it deploy/dsh-host -- \
  vi /data/.dsh/profiles/web/cordis.patch.yml
```

**Publish the host's public key.** The provider generates its signing key on
first boot, and runners read the trusted public key once, at pod start. So the
order matters: deploy the host, publish its key, then create warm pods.

```sh
kubectl -n dsh-sandbox rollout status deployment/dsh-host
kubectl -n dsh-sandbox exec deploy/dsh-host -- dsh-workbench key public \
  > /tmp/dsh-provider.pub
kubectl -n dsh-sandbox create configmap dsh-runner-public-key \
  --from-file=public-key.pem=/tmp/dsh-provider.pub \
  --dry-run=client -o yaml | kubectl apply -f -
```

If warm pods were already created with a different key, recycle them:

```sh
kubectl -n dsh-sandbox delete sandbox --all
```

The pool recreates them with the updated ConfigMap.

**Credentials and secrets** go through the same CLI, never through YAML:

```sh
kubectl -n dsh-sandbox exec -it deploy/dsh-host -- \
  env DSH_SANDBOX_GITHUB_CLIENT_ID=your-oauth-app-client-id \
  dsh-workbench auth github
printf '%s' "$API_KEY" | kubectl -n dsh-sandbox exec -i deploy/dsh-host -- \
  dsh-workbench secret set API_KEY
```

**Reaching the UI.** dsh binds pod loopback by design and has no user
authentication of its own, so the distribution fronts it with
[oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/): the
[`host-oidc.yaml`](../deploy/kubernetes/host-oidc.yaml) patch runs the proxy
next to dsh, terminating OIDC and forwarding over pod-local loopback. The
manifests deliberately stop at the proxy's pod port, 4180 — how to expose it
is your cluster's business. A ClusterIP Service plus an ingress-nginx Ingress
looks like this:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: dsh-host
  namespace: dsh-sandbox
spec:
  selector:
    app.kubernetes.io/name: dsh-host
  ports:
    - name: http
      port: 80
      targetPort: 4180
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dsh-host
  namespace: dsh-sandbox
  annotations:
    # dsh's browser transport holds WebSockets open at /api/events.* and can
    # carry large RPC bodies (attachments); nginx's defaults for read timeout
    # and body size are both too small.
    nginx.ingress.kubernetes.io/proxy-read-timeout: '3600'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '3600'
    nginx.ingress.kubernetes.io/proxy-body-size: 300m
spec:
  ingressClassName: nginx
  rules:
    - host: dsh.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: dsh-host
                port:
                  name: http
  tls:
    - hosts: [dsh.example.com]
      secretName: dsh-host-tls
```

One dsh-side detail is already handled by the patch: dsh's browser-trust
fence rejects any `/api` request whose `Host` header is neither loopback nor
explicitly trusted — its defense against DNS rebinding. The proxy passes the
browser's Host through, so the external hostname is handed to dsh as
`--trusted-host`. If you change the hostname, change it there too.

For yourself, a port-forward always works, with or without the proxy
configured:

```sh
kubectl -n dsh-sandbox port-forward deploy/dsh-host 3000:3000
```

then open `http://localhost:3000`. Loopback is trusted, so no extra flags are
needed.

The proxy authenticates users; it does not isolate them from each other. One
dsh host is one trust domain — everyone the issuer lets through shares the
same sessions, credentials, and sandboxes. Restrict
`OAUTH2_PROXY_EMAIL_DOMAINS` accordingly.

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
