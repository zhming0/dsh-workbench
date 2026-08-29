# dsh-workbench

`dsh-workbench` gives each DeepSeek Harness session its own working
environment. The normal dsh file and command tools use that environment, so the
agent reads, edits, and runs things inside a container instead of on your
machine.

The name avoids dsh's own two meanings of "sandbox" (same-world process
confinement, per `@deepseek-ai/dsh-sandbox`) and "workspace" (the Web UI's
registry of local directories, and the `workspace-write` permission root).
Inside this repository, "sandbox" still means one provisioned environment: it is
the term used by the protobuf contract, the Go module, and the Kubernetes
manifests.

Milestone 1 implements the complete environment lifecycle:

```text
new session -> start sandbox -> clone and set up repository -> run tools
                                                            |
                                                            v
follow-up <- wake with the same files <- hibernate after idle
                                               |
                                               v
                                      delete after expiry
```

The project ships as a **dsh distribution**: container images that run one dsh
host in a Kubernetes cluster, where every session claims its own sandbox from a
warm pool. Internally the provider is an ordinary dsh plugin, and two backends
can provision sandboxes:

- **Kubernetes agent-sandbox** is the product path. It claims a warm Sandbox,
  removes the pod while idle, and keeps the workspace volume until expiry.
- **Docker** is the development substrate. Hibernation stops a container and
  waking starts the same container on the machine dsh runs on.

The supported dsh surface is `dsh web`. Headless is a strict one-shot — fresh
agent, one task, exit — so it defeats session continuity and exits before the
idle lifecycle can run; it is out of scope.

The Kubernetes integration is pinned to agent-sandbox **v0.5.4** and its
`v1beta1` APIs. Both agent-sandbox and dsh are pre-release dependencies, so the
versions in this repository are intentional.

## Getting started on Kubernetes

The distribution is two images, released together under one version so they
cannot drift:

| Image                        | Runs                                                  |
| ---------------------------- | ----------------------------------------------------- |
| `ghcr.io/zhming0/dsh-host`   | dsh with the `web` profile and this provider assembled |
| `ghcr.io/zhming0/dsh-runner` | the per-sandbox server that sessions execute in       |

### Before you start

- A cluster you can install CRDs into, with a default StorageClass. The
  manifests install agent-sandbox v0.5.4 alongside this project's namespace,
  sandbox template, warm pool, RBAC, and the dsh host Deployment.
- A repository for sandboxes to clone. A session is created from a repository
  URL in the Web UI; the code only ever exists in the sandbox. Public
  repositories need nothing more; private ones need the GitHub step below.

### Install

[`docs/kubernetes.md`](docs/kubernetes.md) is the complete walkthrough,
including what each manifest does and the isolation model. The short form:

```sh
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.4/sandbox-with-extensions.yaml

# Replace DSH_HOST_IMAGE_PLACEHOLDER and DSH_RUNNER_IMAGE_PLACEHOLDER with
# released tags first.
kubectl apply -k deploy/kubernetes
```

Then publish the host's signing key. The host generates it on first boot, and
warm runner pods read the trusted public key at start, so it must be published
before the first claim — the exact commands are in
[docs/kubernetes.md](docs/kubernetes.md#the-in-cluster-dsh-host).

### Open dsh and start a session

dsh binds pod loopback by design and ships no user authentication, so reach it
directly with a port-forward:

```sh
kubectl -n dsh-sandbox port-forward deploy/dsh-host 3000:3000
```

Open `http://localhost:3000`. In the browser:

1. Open **New session**, then **Add workspace…**.
2. Enter a repository URL such as `https://github.com/owner/repository`.
3. Choose the resulting Workspace and start the session.

No sandbox exists until that point. The first session claims a warm sandbox,
clones the repository into `/workspace`, and runs `.dsh/setup.sh` if the
repository has one. Each dsh session gets its own sandbox; two sessions never
share files.

### Expose it with OIDC

To share the host beyond a port-forward, apply the
[`deploy/oidc` overlay](deploy/oidc/kustomization.yaml). It adds an
[oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) sidecar that
terminates OIDC in front of dsh, a Service to the proxy, and an example
Ingress. The proxy authenticates users; it does not isolate them. One dsh host
is one trust domain: everyone the issuer admits shares the same sessions,
credentials, and sandboxes.

## Credentials and secrets

These never go in YAML, because configuration is a plain file and a chat
transcript is durable. They go through the distribution's CLI, inside the host
pod:

```sh
kubectl -n dsh-sandbox exec -it deploy/dsh-host -- \
  env DSH_SANDBOX_GITHUB_CLIENT_ID=your-oauth-app-client-id \
  dsh-workbench auth github               # device-code flow, for private repos

printf '%s' "$API_KEY" | kubectl -n dsh-sandbox exec -i deploy/dsh-host -- \
  dsh-workbench secret set API_KEY
kubectl -n dsh-sandbox exec deploy/dsh-host -- dsh-workbench secret list
```

On a development machine the same CLI is at
`~/.dsh/profiles/web/node_modules/.bin/dsh-workbench`, and it shares the
provider's state directory (`~/.dsh-sandbox` unless `stateDir` is configured;
set `DSH_SANDBOX_STATE_DIR` to match if so).

If GitHub authorization is missing when a session needs it, the provider puts
the device-code challenge into the conversation and waits.

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

There is no settings screen for this. dsh's Web settings page has a Plugins
tab, but a plugin appears there only if it both registers a settings namespace
on the host and ships a hand-written browser card for it, and this plugin does
neither.

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
  Workspace is added. Setting it pins a fallback for sessions not created that
  way; leaving it unset also lets the provider auto-detect from
  `git remote get-url origin` in a session's host working directory, which
  only makes sense where dsh runs next to a checkout.

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

In Web, it also replaces host-directory picking with a repository URL dialog.
The resulting Workspace is still owned by dsh; this package supplies a real,
empty host anchor that dsh can use as the session's immutable `cwd`. The
normalized URL lives in an owner-only anchor beneath the provider's state
directory; dsh puts the anchor path in `SessionHeader.cwd`, and the provider
maps it back to the URL before provisioning the sandbox. Sessions created from
ordinary host directories still fall back to the configured `repository`, then
`git remote get-url origin` in that directory.

One tool is turned off. `glob` and `grep` come from `tool-fs-search`, which
spawns a ripgrep binary resolved from the dsh host's own `node_modules`. That
path does not exist inside the sandbox, so the tools would fail on every call.
Searching a remote filesystem needs a provider-side search backend that this
milestone does not have. The agent can still use `grep` and `find` through
`bash`.

## What changes for the agent

|                                               | Before                    | After                       |
| --------------------------------------------- | ------------------------- | --------------------------- |
| `read`, `write`, `edit`, `str_replace_editor` | your disk                 | sandbox workspace           |
| `bash`                                        | your machine              | sandbox                     |
| `glob`, `grep`                                | ripgrep on your machine   | unavailable; use `bash`     |
| Working directory                             | wherever you launched dsh | `/workspace` in the sandbox |
| Session logs, attachments, spill files        | your disk                 | unchanged, still your disk  |

Turning off `fs-sandbox` also turns off dsh's host-side permission model:
`workspace-write` and the approval prompts came from that row. This is
deliberate. The container is the boundary now, and asking permission to write a
file inside a disposable container is noise. It does mean the agent can do
anything it likes inside the sandbox without asking, so treat the sandbox, not
the prompt, as the thing standing between a repository and your machine.

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
`~/.dsh`) and `~/.dsh-sandbox`, and the CLI is at
`$DSH_HOME/profiles/web/node_modules/.bin/dsh-workbench`.

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

## Repository layout

| Path                 | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `provider/`          | TypeScript dsh plugin, bundle patch, lifecycle policy, backends, credential broker |
| `runner/`            | Go server that runs inside each sandbox                                            |
| `proto/`             | Single ConnectRPC contract used by provider and runner                             |
| `deploy/kubernetes/` | Reference warm pool, template, network policy, RBAC, and host Deployment          |
| `deploy/oidc/`       | Overlay exposing the host behind oauth2-proxy                                      |
| `scripts/kas/`       | Disposable kind cluster and lifecycle smoke test                                   |
| `examples/`          | Agent preset for the per-session route                                             |

## Build and test

[`mise.toml`](mise.toml) pins Node, Go, and the protobuf plugins, and CI
installs from the same file, so a build and a laptop agree by construction.
Install [mise](https://mise.jdx.dev), then:

```sh
mise install
corepack enable pnpm
```

pnpm is pinned by the `packageManager` field in `package.json` rather than by
`mise.toml`, and corepack reads it. Buf arrives with `pnpm install`. Docker is
needed for the end-to-end local test. `docker buildx bake dev` builds the runner
image for the current machine; the release build covers `linux/amd64` and
`linux/arm64`.

```sh
pnpm install
pnpm check
pnpm test
pnpm build

(cd runner && go test -race ./... && go vet ./... && go build ./cmd/dsh-runner)
docker buildx bake dev --load
pnpm test:docker
```

The Docker smoke test checks signed access, secret injection, Git/Jujutsu/mise,
first-run setup, and file survival across stop/start.

To regenerate code after editing the protobuf file:

```sh
pnpm proto:generate
```

For the Kubernetes lifecycle, `scripts/kas/dev-cluster.sh` creates a disposable
kind cluster with both dev images and `scripts/kas/smoke-test.sh` checks warm
claim, suspend, resume, volume persistence, and expiry against it. The exact
commands are at the top of [docs/kubernetes.md](docs/kubernetes.md).

### Development environment (laptop + Docker)

Instead of the images, a checkout installs into a dsh you run yourself. This
needs `@deepseek-ai/dsh` 0.1.1-rc.2 on your PATH. Build first, then install
the provider directory:

```sh
docker buildx bake dev --load
pnpm install && pnpm build
dsh plugin --profile web add "$PWD/provider"
```

With no `backend` configured the provider selects Docker, so point the manager
at the locally built runner image in your profile layer and run `dsh web`:

```yaml
- id: sandbox-manager
  config:
    docker:
      image: dsh-runner:dev
```

## Observability

The provider records OpenTelemetry claim time, resume time, lifecycle changes,
and command time through the dsh host's OpenTelemetry setup. The runner exports
HTTP traces and command-duration metrics when standard `OTEL_*` exporter or
collector environment variables are present. With no telemetry configuration, it
does not try to contact a local collector.

## Releasing

Every release publishes two images together, both built for `linux/amd64` and
`linux/arm64`: `ghcr.io/zhming0/dsh-host`, the dsh distribution with the web
profile and this provider assembled, and `ghcr.io/zhming0/dsh-runner`. They
share one calendar version. The host image build stamps that version into the
provider and fails if the provider's default runner image tag would not match,
so the pair cannot drift. The provider is no longer published to npm; the
distribution images are the product, and a checkout install is the contributor
path (see [`docs/plans/distribution.md`](docs/plans/distribution.md)).

Buildkite runs [`.buildkite/pipeline.yml`](.buildkite/pipeline.yml) on every
branch: provider checks and tests, runner tests, a check that the generated
protobuf code is current, and the Docker lifecycle smoke test.

On `main` a manual block step unlocks
[`.buildkite/pipeline.release.yml`](.buildkite/pipeline.release.yml), which picks
a calendar version, pushes both multi-architecture images, and tags a GitHub
release.

## Milestone 1 boundaries

This release does not include interactive terminals, live streaming stdin,
service supervision, public service URLs, cross-sandbox child agents, or
sandbox-side `glob` and `grep`. It does support one-shot stdin, streamed output,
command cancellation, bounded background output, automatic idle hibernation,
wake, and final cleanup.
