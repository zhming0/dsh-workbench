# dsh-workbench Helm chart

Installs the dsh-workbench **control plane**: one dsh host, its data volume,
the tunnel Service runners dial, the shared registration token, and the
identity and permissions the host uses to operate Kubernetes sandboxes.

This chart does not install sandboxes. Setting a runner up is a second phase:
[installations-control-plane.md](../../../docs/installations-control-plane.md)
covers this install, then
[docs/installations.md](../../../docs/installations.md) points to
[installations-kas.md](../../../docs/installations-kas.md) for the Kubernetes
sandbox pool in [`deploy/kubernetes/runner`](../../kubernetes/runner), or
[installations-buildkite.md](../../../docs/installations-buildkite.md) for
Buildkite agents.

Installing this chart alone gives you a working host: the Web UI, sessions,
secrets, instructions, and repository workspaces all work. The first tool call
in a session needs a sandbox, so it fails with a message naming the missing
runner until a runner is set up and the provider points at it.

## Prerequisites

- a Kubernetes cluster and an OIDC identity provider, unless you reach the
  host over `kubectl port-forward`
- a default StorageClass for the host data volume, or `host.persistence.storageClass`

## Install

```sh
helm install dsh-workbench oci://ghcr.io/zhming0/charts/dsh-workbench \
  --namespace dsh-sandbox --create-namespace \
  --set oidc.enabled=true \
  --set oidc.hostname=dsh.example.com \
  --set service.type=LoadBalancer
```

The release must be named `dsh-workbench` and live in one namespace per host:
the pool's manifests read the fixed names `dsh-host-tunnel`, `dsh-runner-config`,
and `dsh-registration-token`, which this release owns.

Create the proxy's OIDC Secret first — NOTES.txt has the command; until it
exists the pod runs but never becomes Ready. Without `oidc.enabled`, reach the
host over `kubectl port-forward` and open `/launch-token`.

## Values

| Key | Default | Description |
| --- | ------- | ----------- |
| `host.image.repository` | `ghcr.io/zhming0/dsh-host` | Host image |
| `host.image.tag` | `.Chart.appVersion` | Released host tag |
| `host.resources` | `250m/512Mi → 2Gi` | Host container resources |
| `host.extraArgs` | `[]` | Extra dsh web app arguments |
| `host.extraEnv` | `[]` | Extra host env vars, for a credential the host needs itself (`BUILDKITE_API_TOKEN`, say) from a Secret you own; never a sandbox secret |
| `host.podAnnotations` / `host.podLabels` | `{}` | Extra pod metadata |
| `host.persistence.enabled` | `true` | `false` swaps the data PVC for an emptyDir — every restart then loses sessions and the credentials store, silently |
| `host.persistence.size` | `5Gi` | Host data volume size |
| `host.persistence.storageClass` | `""` | Host data volume StorageClass; required when the cluster has no default |
| `runner.hostUrl` | `ws://dsh-host-tunnel.<namespace>.svc.cluster.local:8081/tunnel` | Tunnel address written into `dsh-runner-config`; set only for an unusual layout |
| `registrationToken.existingSecret` | `""` | Existing Secret with the shared token under key `token`; no Secret is created |
| `registrationToken.value` | `""` | Fixed token; a stable random one is generated when empty |
| `oidc.enabled` | `false` | Add the oauth2-proxy sidecar, `--trusted-host`, and the proxy Service |
| `oidc.hostname` | `""` | Required when enabled: bare host, no scheme |
| `oidc.image` | `quay.io/oauth2-proxy/oauth2-proxy:v7.15.4` | Proxy image |
| `oidc.existingSecret` | `dsh-host-oidc` | Secret with the proxy's OIDC and cookie configuration |
| `oidc.emailDomains` | `*` | `OAUTH2_PROXY_EMAIL_DOMAINS` — restrict before trusting an issuer's whole user base |
| `oidc.extraEnv` | `[]` | Extra env vars for the proxy, appended after the fixed ones |
| `service.type` | `ClusterIP` | Exposure type for the proxy Service |
| `service.port` | `80` | Service port in front of the proxy's 4180 |
| `service.annotations` | `{}` | Cloud/controller annotations for the Service |
| `provider.sandboxManager` | `{}` | The provider's sandbox-manager settings, rendered verbatim; unset seeds no profile, so no sandbox can be provisioned |

## Provider settings as values

`provider.sandboxManager` is the interface for the provider's sandbox-manager
settings on a chart install. The chart renders it into a read-only patch layer
at `/data/.dsh/cordis.patch.yml`, which dsh applies after the seeded profile
file, and an id-targeted patch row replaces the whole `sandbox-manager`
config. So:

- a values change applies when `helm upgrade` restarts the pod (a checksum
  annotation tracks it), not live;
- a `kas` profile that names no namespace is rendered with the release
  namespace, because the provider's own default is the fixed name
  `dsh-sandbox`;
- the row is otherwise rendered verbatim — the provider's own validation is the
  schema. The chart guard requires at least one profile and that every `kas`
  profile targets the release namespace, where the host's Role and the tunnel
  Service live.

For a Kubernetes pool, name it in the profile:

```sh
helm upgrade dsh-workbench oci://ghcr.io/zhming0/charts/dsh-workbench \
  --namespace dsh-sandbox \
  --reuse-values \
  --set provider.sandboxManager.profiles.standard.backend=kas \
  --set provider.sandboxManager.profiles.standard.warmPool=dsh-universal
```

See [provider settings](../../../provider/README.md#settings) for the full row
schema.

## Notes

- The data PVC carries `helm.sh/resource-policy: keep`, so `helm uninstall`
  leaves sessions, credentials, and the seeded profile on the volume.
- The registration token Secret is generated once per release and reused on
  upgrades; rotating it follows
  [docs/kubernetes.md](../../../docs/kubernetes.md#the-in-cluster-dsh-host).
- **GitOps (Argo CD, Flux):** those renderers have no live cluster, so the
  lookup that keeps the generated token stable cannot find the existing Secret
  and every sync invents a new one — the release never converges and the token
  rotates under the warm pods. Set `registrationToken.value` from your secret
  store, or `registrationToken.existingSecret`.
- The chart deliberately ships no Ingress: the proxy Service is the anchor.
  Whatever fronts dsh must serve https, pass WebSockets, and allow large RPC
  bodies — [docs/kubernetes.md](../../../docs/kubernetes.md) has the
  nginx-ingress reference values.
