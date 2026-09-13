# Control plane

The `dsh-workbench` Helm chart installs the host: the dsh process, its data
volume, the tunnel Service runners dial, the shared registration token, and the
host's Kubernetes API access. Where sandboxes run is a separate install — see
[installation](installations.md).

## Prerequisites

- a Kubernetes cluster you administer, and `kubectl` ≥ 1.27
- `helm` ≥ 3.8
- a default StorageClass, or a storage class name for the host data volume
- an OIDC identity provider — dsh ships no user authentication, so the
  distribution fronts it with oauth2-proxy and you supply the client. Skip it
  when `kubectl port-forward` access is enough.

## Install

Everything installs into one namespace, `dsh-sandbox` in the examples. One
namespace holds one dsh host: the release must be named `dsh-workbench`, and
the fixed names it owns are what the runner setup reads later.

Create the proxy's OIDC Secret first. Secret values never belong in values
files, so the chart deliberately never sees them:

```sh
kubectl create namespace dsh-sandbox
kubectl -n dsh-sandbox create secret generic dsh-host-oidc \
  --from-literal=OAUTH2_PROXY_OIDC_ISSUER_URL=https://your-idp/realm \
  --from-literal=OAUTH2_PROXY_CLIENT_ID=dsh-host \
  --from-literal=OAUTH2_PROXY_CLIENT_SECRET=… \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"
```

```yaml
# dsh-workbench.values.yaml
oidc:
  enabled: true
  hostname: dsh.example.com
  emailDomains: your-company.com
service:
  type: LoadBalancer
```

```sh
helm install dsh-workbench oci://ghcr.io/zhming0/charts/dsh-workbench \
  --namespace dsh-sandbox \
  --values dsh-workbench.values.yaml
```

The chart creates the `dsh-registration-token` Secret with a generated token
that survives `helm upgrade`; `registrationToken.value` or
`registrationToken.existingSecret` supplies your own. It also gives the host
the `dsh-provider` identity — a ServiceAccount, a Role for `sandboxclaims` and
`sandboxes` in the release namespace, and the RoleBinding between them — which
is all a Kubernetes runner needs from you.

The Service is a ClusterIP anchor by default. Set `service.type=LoadBalancer`
or point your own Ingress or Gateway API route at it; whatever fronts dsh must
serve https and pass WebSockets and large RPC bodies.
[`kubernetes.md`](kubernetes.md) has the nginx-ingress values.

Without `oidc.enabled`, reach the host over `kubectl port-forward` and open
`/launch-token`; NOTES.txt prints the command.

## Verify

```sh
kubectl -n dsh-sandbox rollout status deployment/dsh-workbench --timeout=300s
```

The pod becomes Ready once dsh is serving. Open the address you exposed and you
land signed in through `/launch-token`; the Web UI works, and you can create a
session, add secrets, and set up a repository workspace. Starting a turn fails
at the first tool call until a runner is set up, which is expected.

## Credentials

Three credentials touch this install:

- **The proxy's OIDC client secret** goes in the `dsh-host-oidc` Secret above.
- **The shared registration token** is created by the chart. Supply your own
  with `registrationToken.value` or `registrationToken.existingSecret`;
  [`kubernetes.md`](kubernetes.md#the-in-cluster-dsh-host) covers rotation.
- **A credential the host uses itself** — a Buildkite API token, for example —
  goes in a Secret you own and reaches the host through `host.extraEnv`:

```sh
kubectl -n dsh-sandbox create secret generic dsh-buildkite \
  --from-literal=token="$BUILDKITE_API_TOKEN"
```

```yaml
host:
  extraEnv:
    - name: BUILDKITE_API_TOKEN
      valueFrom:
        secretKeyRef:
          name: dsh-buildkite
          key: token
```

The host reads these variables once, at startup: after changing the Secret,
restart the pod. A credential like this must not go in the provider's secret
store, which is pushed into every sandbox —
[`credentials.md`](credentials.md) is about that store.

## Upgrade

`helm upgrade` moves the control plane. It does not touch a runner; re-apply
the runner's manifests at the same version to move its image.
