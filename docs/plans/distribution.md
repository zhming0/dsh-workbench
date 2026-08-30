# dsh-workbench as a distribution

## Problem

This project has been positioned as an npm plugin the user installs into their
own dsh profile. That positioning has three costs:

- **Version skew.** dsh is pre-1.0 and its surface moves between release
  candidates. "Install this into whatever dsh you have" creates a support
  matrix nobody can win; the plugin pins `0.1.1-rc.2` exactly.
- **Assembly burden.** Most of the README exists to teach profiles, patch
  layers, and replace-not-merge semantics — education required only because
  the user composes the system themselves.
- **Topology burden.** The `kas` backend requires a dsh host that can reach
  in-cluster Sandbox service names. Explaining that to a laptop user is the
  hardest part of the docs, and the plugin positioning forces the explanation.

## Positioning

dsh-workbench is a **dsh distribution for Kubernetes**: container images you
deploy, not a package you install. The dsh host runs in the cluster, which
satisfies the reachability requirement by construction, and every version in
the stack — dsh, the plugin, the runner — is pinned and tested together.

Three artifacts ship per release, sharing one calendar version so none can
drift:

| Artifact                       | Role                                              |
| ------------------------------ | ------------------------------------------------- |
| `ghcr.io/zhming0/dsh-host`     | dsh + the `web` profile with this plugin, wired   |
| `ghcr.io/zhming0/dsh-runner`   | the in-sandbox server (unchanged)                 |
| GitHub release                 | tag, notes, and the manifest reference            |

**npm publishing stops.** The published plugin served the persona "existing
dsh user adds sandboxing to their own profile", which does not exist at dsh's
current adoption. The provider remains an ordinary plugin internally — the
image installs it from the checkout — and installing from a checkout stays the
contributor path. Already-published versions remain on npm; they are no longer
maintained as a product surface.

**The laptop+docker path is repositioned as the development environment** for
this repository, not an end-user product. The docker backend stays: it is the
CI substrate and the fast local loop. A containerized laptop distribution
would need the docker backend to reach runners from inside a container
(published loopback ports are host-relative), and no user needs that today.

**The supported dsh surface is `web`.** Headless is a strict one-shot — fresh
agent, one task, exit — which defeats session continuity and exits before the
idle lifecycle can run. It is out of scope.

## The dsh-host image

Design rule: **the image owns the software, the home volume owns the data.**

The container user's home directory is `/data`, the single mount point.
Everything durable already defaults to paths under the home directory, so no
path needs configuring:

| Path under `/data`         | Owner  | Content                                     |
| -------------------------- | ------ | ------------------------------------------- |
| `.dsh/profiles/web`        | image  | seeded profile: plugin install, manifest    |
| `.dsh/profiles/web/cordis.patch.yml` | user | settings; seeded once with `backend: kas` |
| `.dsh/sessions`, `.dsh/storages` | dsh | conversations and storage (`dshHomePath`) |
| `.dsh-sandbox/`            | plugin | signing key, session records, broker store  |

The image bakes the assembled profile under `/opt/dsh-host/profile` at build
time: the provider is packed into a real npm tarball and installed with
`dsh plugin --profile web add`, exactly like a registry package, so its
dependencies resolve into the profile and the composition cannot drift from
what a boot loads. An entrypoint seed step
copies it into the volume when missing and refreshes it when the image version
marker changes, never touching user-owned files. A starter
`cordis.patch.yml` with `backend: kas` is written only if absent.

The dsh version is **derived, not repeated**: the Dockerfile reads the
`@deepseek-ai/dsh-agent` pin from `provider/package.json` and installs
`@deepseek-ai/dsh` at that version. A provider test asserts every
`@deepseek-ai/dsh-*` pin in that manifest is identical, so the derivation has
one answer. The release-time invariant that the provider's default runner
image tag equals the published image tag moves from the npm publish step into
the image build itself.

The web server binds loopback inside the pod by design. Exposure and
authentication are the manifest's job (below), not the image's.

## Delivery slices

1. **Image and release rewiring** (this change): `host/Dockerfile`, seed
   entrypoint, bake targets (`host-dev`, `host-production`), CI step that
   builds the image and checks the composed tree, release pipeline drops the
   npm publish and pushes both images, dsh-version uniformity test.
2. **Kubernetes manifests**: a `dsh-host` Deployment in `deploy/kubernetes/`
   — `/data` PVC, ServiceAccount bound to the existing `dsh-provider` Role —
   with an oauth2-proxy container terminating OIDC and upstreaming to
   loopback, and `--trusted-host` for the external hostname. The proxy is
   part of the distribution, applied by the kustomization as a patch
   (`host-oidc.yaml`) over the raw Deployment; the dev-cluster script applies
   the raw manifests and skips it, so kind runs need no identity provider.
   No Service or Ingress ships: the manifests stop at the proxy's pod port
   and exposure is the operator's choice (an ingress-nginx example with
   WebSocket/body-size headroom lives in docs/kubernetes.md). The proxy is an
   ordinary container, not a native sidecar: the two servers have no
   startup-order dependency. Verify WebSocket/SSE pass-through and the trust
   fence behind the proxy against the dsh-web-app source. Document
   `kubectl exec`-based `dsh-workbench auth github` / `secret set` flows.
3. **README restructure**: distribution-first getting started (apply
   manifests, port-forward or Ingress, open browser); plugin/profile material
   moves to contributor docs; headless scope statement; laptop+docker
   presented as the development path.

## Non-goals

- A laptop distribution image (docker backend from inside a container).
- Tunnel or dial-out transport for out-of-cluster hosts (deferred by D6).
- Renaming the project or migrating the npm scope.
- User-supplied extra plugins inside the image-managed profile. The profile is
  image-owned; composing more plugins means building a derived image. This
  keeps upgrades a marker-file refresh instead of an in-volume migration.

## Risks

- **Profile refresh vs. user edits.** The seed step overwrites image-owned
  profile files on version change. Mitigated by keeping the user's whole
  configuration in `cordis.patch.yml`, which the refresh never touches.
- **dsh template drift.** The `web` profile auto-initializes from dsh's
  shipped template at bake time; an RC bump can change what the template
  seeds. The CI image check (`--dump-config` must compose the
  `sandbox-manager` row) catches a composition that no longer loads.
- **Cross-architecture build cost.** `npm install -g` under QEMU for the arm64
  layer is slow but bounded; acceptable at current release cadence.
