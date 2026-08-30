# dsh-workbench

A Kubernetes distribution of [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)
(dsh). You run one dsh host in your cluster. Each session claims its own
sandbox from a warm pool, and dsh's stock file and command tools work inside
that sandbox — never on the host.

**Who this is for.** Running it takes three pieces of infrastructure, all
yours to operate:

- a Kubernetes cluster you administer — installing means applying CRDs and a
  controller;
- [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox), pinned to
  **v0.5.4** and its `v1beta1` APIs; the install steps below apply it. Both
  dsh and agent-sandbox are pre-release, so the pinned versions in this
  repository are intentional;
- an OIDC identity provider. dsh ships no user authentication, so the
  distribution fronts it with oauth2-proxy and you supply the OIDC client.

If that is not your situation, this project is not a turnkey tool. A
Docker-backend mode exists for running sessions in containers on one machine,
but it is the development path, not the product — see
[docs/development.md](docs/development.md).

The supported dsh surface is `dsh web`. Headless mode runs a fresh agent on
one task and exits, so it never reaches the idle lifecycle and is out of
scope.

Each session's sandbox goes through this lifecycle:

```text
new session -> start sandbox -> clone and set up repository -> run tools
                                                            |
                                                            v
follow-up <- wake with the same files <- hibernate after idle
                                               |
                                               v
                                      delete after expiry
```

A sandbox is claimed from the warm pool when the session starts. While the
session idles, the sandbox's pod is removed; its workspace volume survives
until expiry. In this repository, "sandbox" always means one such provisioned
environment — the term the protobuf contract, the Go module, and the
Kubernetes manifests all use.

## Getting started

The distribution is two images, released together under one version so they
cannot drift:

| Image                        | Runs                                                  |
| ---------------------------- | ----------------------------------------------------- |
| `ghcr.io/zhming0/dsh-host`   | dsh with the `web` profile and this provider assembled |
| `ghcr.io/zhming0/dsh-runner` | the per-sandbox server that sessions execute in       |

### Before you start

- The cluster needs a default StorageClass. The manifests install
  agent-sandbox v0.5.4 alongside this project's namespace, sandbox template,
  warm pool, RBAC, and the dsh host Deployment.
- Register an OIDC client at your identity provider for
  [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/): you need the
  issuer URL, client ID, and client secret.
- Pick a repository for sandboxes to clone. A session is created from a
  repository URL in the Web UI; the code only ever exists in the sandbox.
  Public repositories need nothing more; private ones need the GitHub step
  below.

### Install

[`docs/kubernetes.md`](docs/kubernetes.md) is the complete walkthrough,
including what each manifest does and the isolation model. The short form:

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.4/sandbox-with-extensions.yaml

kubectl create namespace dsh-sandbox
kubectl -n dsh-sandbox create secret generic dsh-host-oidc \
  --from-literal=OAUTH2_PROXY_OIDC_ISSUER_URL=https://your-idp/realm \
  --from-literal=OAUTH2_PROXY_CLIENT_ID=dsh-host \
  --from-literal=OAUTH2_PROXY_CLIENT_SECRET=… \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"

# Replace DSH_HOST_IMAGE_PLACEHOLDER and DSH_RUNNER_IMAGE_PLACEHOLDER with
# released tags, and dsh.example.com in host-oidc.yaml with your hostname.
kubectl apply -k deploy/kubernetes
```

The manifests deliberately stop at the proxy's pod port, 4180: put a Service
and an Ingress, LoadBalancer, or Gateway of your choosing in front of it
([docs/kubernetes.md](docs/kubernetes.md#the-in-cluster-dsh-host) has an
ingress-nginx example with the WebSocket and body-size headroom dsh needs).
The proxy authenticates users; it does not isolate them. One dsh host is one
trust domain: everyone the issuer admits shares the same sessions,
credentials, and sandboxes.

Then publish the host's signing key. The host generates it on first boot, and
warm runner pods read the trusted public key when they start, so publish it
before the first claim. The exact commands are in
[docs/kubernetes.md](docs/kubernetes.md#the-in-cluster-dsh-host).

### Start a session

Open the host at your hostname (or, before exposure is wired up,
`kubectl -n dsh-sandbox port-forward deploy/dsh-host 3000:3000` and
`http://localhost:3000` — dsh answers on pod loopback even while the proxy
container still waits for its Secret). In the browser:

1. Open **New session**, then **Add workspace…**.
2. Enter a repository URL such as `https://github.com/owner/repository`.
3. Choose the resulting Workspace and start the session.

No sandbox exists until that point. The first session claims a warm sandbox,
clones the repository into `/workspace`, and runs `.dsh/setup.sh` if the
repository has one. Each dsh session gets its own sandbox; two sessions never
share files.

## Credentials and secrets

Never put credentials in configuration: the configuration file is plain YAML,
and chat transcripts are durable. Credentials go through the distribution's
CLI inside the host pod instead:

```sh
kubectl -n dsh-sandbox exec -it deploy/dsh-host -- \
  env DSH_SANDBOX_GITHUB_CLIENT_ID=your-oauth-app-client-id \
  dsh-workbench auth github               # device-code flow, for private repos

printf '%s' "$API_KEY" | kubectl -n dsh-sandbox exec -i deploy/dsh-host -- \
  dsh-workbench secret set API_KEY
kubectl -n dsh-sandbox exec deploy/dsh-host -- dsh-workbench secret list
```

If GitHub authorization is missing when a session needs it, the provider puts
the device-code challenge into the conversation and waits.
([docs/development.md](docs/development.md) has the CLI's location on a
development machine.)

## Configuration

dsh has no single application. What runs is a plugin tree composed at boot,
and a **profile** is one named, installed copy of such a tree. The host image
ships the `web` profile pre-assembled with this provider and seeds it into the
data volume on first boot; upgrades refresh the image-owned files. The one
file in the profile that belongs to you is its override layer:

```text
/data/.dsh/profiles/web/cordis.patch.yml    # in the host pod
$DSH_HOME/profiles/web/cordis.patch.yml     # development machine; $DSH_HOME defaults to ~/.dsh
```

There is no settings screen for this: a plugin appears in dsh's Web Plugins
tab only if it registers a settings namespace and ships a browser card, and
this plugin does neither.

The file is a list of patches against the composed plugin tree. An entry is
matched by row id, and `sandbox-manager` is the row this package's bundle patch
inserted. A patch **replaces** that row's whole `config` rather than merging
into it, so restate every field you want to keep:

```yaml
- id: sandbox-manager
  config:
    backend: kas
    idleMs: 300000 # hibernate after 5 minutes instead of 10
```

The file is watched, so a saved edit reaches the next session without
restarting dsh. Run `dsh --profile web --dump-config` to print the composed
tree and confirm your patch landed (in the pod:
`kubectl -n dsh-sandbox exec deploy/dsh-host -- dsh --profile web --dump-config`).

Two settings worth knowing about up front:

- The image seeds `backend: kas`, pointing at the manifest's namespace and
  warm pool. On a development machine the defaults select `docker` instead — a
  complete working configuration by itself.
- `repository` is normally unset: the Web UI asks for a repository URL when a
  Workspace is added. Setting it pins a fallback for sessions created some
  other way. When it is unset, the provider can also auto-detect the URL from
  `git remote get-url origin` in a session's host working directory — useful
  only where dsh runs next to a checkout.

Every setting, with its default, is in
[`provider/README.md`](provider/README.md#settings).

## What this changes in dsh

The bundle patch is [`provider/cordis.patch.yml`](provider/cordis.patch.yml).
It turns off three host capability rows and inserts sandbox-backed replacements:

| Row            | Before                      | After                                  |
| -------------- | --------------------------- | -------------------------------------- |
| `fs-sandbox`   | reads and writes your disk  | reads and writes the sandbox workspace |
| `bash-sandbox` | runs `bash` on your machine | runs `bash` in the sandbox             |
| `subprocess`   | spawns host processes       | spawns processes in the sandbox        |

It leaves every tool row alone, so the stock `standard` and `code` agent presets
keep working and simply point at the sandbox.

In Web, the patch also replaces host-directory picking with a repository URL
dialog. dsh still owns the resulting Workspace; this package gives it a real,
empty host directory to use as the session's immutable `cwd` — an owner-only
anchor beneath the provider's state directory that records the normalized URL.
dsh stores the anchor path in `SessionHeader.cwd`, and the provider maps that
path back to the repository URL before provisioning the sandbox. Sessions
created from ordinary host directories still fall back to the configured
`repository`, then to `git remote get-url origin` in that directory.

One tool is turned off. `glob` and `grep` come from `tool-fs-search`, which
spawns a ripgrep binary resolved from the dsh host's own `node_modules` — a
path that does not exist inside the sandbox, so the tools would fail on every
call. Searching a remote filesystem needs a provider-side search backend that
this milestone does not have. The agent can still use `grep` and `find`
through `bash`.

## What changes for the agent

|                                               | Before                    | After                       |
| --------------------------------------------- | ------------------------- | --------------------------- |
| `read`, `write`, `edit`, `str_replace_editor` | your disk                 | sandbox workspace           |
| `bash`                                        | your machine              | sandbox                     |
| `glob`, `grep`                                | ripgrep on your machine   | unavailable; use `bash`     |
| Working directory                             | wherever you launched dsh | `/workspace` in the sandbox |
| Session logs, attachments, spill files        | your disk                 | unchanged, still your disk  |

Turning off `fs-sandbox` also turns off dsh's host-side permission model:
`workspace-write` and the approval prompts came from that row. The container
is the boundary instead, and the agent acts inside it without asking — treat
the sandbox, not the prompt, as what stands between a repository and your
machine.

## Where files live

In the host pod, everything that must survive a restart is on the `/data`
volume:

| Path                                        | What                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `/data/.dsh/profiles/web/cordis.patch.yml`  | every setting you configure                            |
| `/data/.dsh/profiles/web/`                  | the assembled profile, refreshed from the image        |
| `/data/.dsh/sessions`, `/data/.dsh/storages`| dsh's own session logs and attachments                 |
| `/data/.dsh-sandbox/`                       | signing key, session records, broker store, owner-only |
| `/workspace` inside each sandbox            | the cloned repository                                  |

On a development machine the same layout sits under `$DSH_HOME` (default
`~/.dsh`) and `~/.dsh-sandbox`.

## Per-session sandboxes instead of profile-wide

If you want sandbox tools in some sessions and host tools in others, use an
agent preset instead of the bundle patch. A preset is a per-session tool loadout
that the web UI mounts when you pick it:

```sh
cp -r examples ~/.dsh/.agent-presets/sandbox
```

[`examples/agent.cordis.yml`](examples/agent.cordis.yml) has the composition and
the profile edits that neutralize the bundle layer first. The two routes are
alternatives; running both gives a session two sandboxes.

## Trust boundaries

- The provider's signing key, GitHub token, and configured secrets stay in an
  owner-only directory on the dsh host.
- A runner keeps pushed credentials in memory. Its Git helper reads them from a
  private Unix socket, not from the workspace.
- Secret values are added only to child-process environments. Repository code
  can read them by design, so only run repositories trusted with those values.
- The accepted GitHub device-flow token is user-wide, not repository-scoped.
  This suits one dsh user per provider instance, not shared hosting.
- The provider always starts connections. The runner never needs a route back to
  the dsh host. Short-lived signed tokens protect every runner call and include
  the expected sandbox identity.

## Observability

The provider records claim time, resume time, lifecycle changes, and command
time through the dsh host's OpenTelemetry setup. The runner exports HTTP
traces and command-duration metrics when the standard `OTEL_*` exporter or
collector environment variables are set; without them, it does not try to
contact a local collector.

## Development

[`docs/development.md`](docs/development.md) covers the repository layout,
building and testing, running from a checkout against a dsh on your own
machine, and how releases are cut.

## Milestone 1 boundaries

This release does not include interactive terminals, live streaming stdin,
service supervision, public service URLs, cross-sandbox child agents, or
sandbox-side `glob` and `grep`. It does support one-shot stdin, streamed output,
command cancellation, bounded background output, automatic idle hibernation,
wake, and final cleanup.
