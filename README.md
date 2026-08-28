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

The project supports two ways to run a sandbox:

- **Docker** is the default and the local development path. Hibernation stops a
  container and waking starts the same container.
- **Kubernetes agent-sandbox** is the cluster path. It claims a warm Sandbox,
  removes the pod while idle, and keeps the workspace volume until expiry.

The Kubernetes integration is pinned to agent-sandbox **v0.5.4** and its
`v1beta1` APIs. Both agent-sandbox and dsh are pre-release dependencies, so the
versions in this repository are intentional.

## Getting started

### Before you start

- [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.1.1-rc.2`, and pnpm
  on your `PATH`, which is what dsh uses to install plugins.
- Docker running on the same machine as dsh.
- A repository for the sandbox to clone. There are two ways to name one, and
  they suit different setups:

|                 | How the repository is named                                                                                   | Needs a local clone?                          |
| --------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Name it**     | Set `repository` to any git URL                                                                               | No. The code only ever exists in the sandbox. |
| **Auto-detect** | Leave `repository` unset and the provider runs `git remote get-url origin` in the session's working directory | Yes, and that directory must be the checkout  |

Naming it suits one profile per project. Auto-detect suits one profile you use
across many checkouts. Public repositories need nothing more; private ones need
the GitHub step below.

### What a dsh profile is

dsh has no single application. What you get when you run it is a plugin tree,
composed at boot. A **profile** is one named, installed copy of such a tree:

```text
$DSH_HOME/profiles/<name>/     # $DSH_HOME defaults to ~/.dsh
  package.json                 # your installed plugins, and the ordered bundle list
  cordis.patch.yml             # your own override layer
  node_modules/                # where those plugins actually live
```

`dsh web` boots the `web` profile. `dsh --profile headless "a task"` boots the
`headless` profile. Same core, different surface.

Profiles matter here for two reasons. There is no global plugin directory, so
this package has to be installed into a specific profile before dsh can resolve
it. And this package does not add a tool: it replaces the `fs`, `shell`, and
`subprocess` services that dsh's built-in tools already use, which means editing
a layer of the composed tree.

### 1. Install

```sh
dsh plugin --profile web add @zhming0/dsh-workbench
```

That is the whole install. This package declares a bundle patch, so dsh appends
it to the profile's layer stack and the patch applies on the next boot.

### 2. Choose where sandboxes run

Every setting in this plugin is written to one file, your profile's own
override layer. Create it if it does not exist:

```text
$DSH_HOME/profiles/web/cordis.patch.yml     # $DSH_HOME defaults to ~/.dsh
```

There is no settings screen for this. dsh's Web settings page has a Plugins
tab, but a plugin appears there only if it both registers a settings namespace
on the host and ships a hand-written browser card for it, and this plugin does
neither.

**Docker: leave the file empty, or skip creating it.** The defaults are already
a complete working configuration:

| Setting        | Resolves to                                                      |
| -------------- | ---------------------------------------------------------------- |
| `backend`      | `docker`                                                         |
| `docker.image` | the runner image released with this package, pulled on first use |
| `stateDir`     | `~/.dsh-sandbox`, with a signing key generated on first boot     |
| `repository`   | unset, so the `origin` remote of the session's working directory |
| `workspace`    | `/workspace` inside the sandbox                                  |

**Kubernetes: this is not a laptop path.** A runner is only reachable
in-cluster at its Sandbox service name, so the dsh process itself has to run in
or beside the cluster. It also needs agent-sandbox v0.5.4, a warm pool, and the
provider's public key deployed before the first claim. Read
[Pointing at a real cluster](#pointing-at-a-real-cluster) first, then write:

```yaml
- id: sandbox-manager
  config:
    backend: kas
    kas:
      namespace: dsh-sandbox
      warmPool: dsh-universal
```

That file is a list of patches against the composed plugin tree. An entry is
matched by row id, and `sandbox-manager` is the row this package's bundle patch
inserted. A patch **replaces** that row's whole `config` rather than merging
into it, so restate every field you want to keep:

```yaml
- id: sandbox-manager
  config:
    backend: kas
    idleMs: 300000 # hibernate after 5 minutes instead of 10
    kas:
      namespace: dsh-sandbox
      warmPool: dsh-universal
```

The file is watched, so a saved edit reaches the next session without
restarting dsh. Run `dsh --profile web --dump-config` to print the composed
tree and confirm your patch landed.

Every setting, with its default, is in
[`provider/README.md`](provider/README.md#settings).

### 3. What the install changed

The bundle patch is [`provider/cordis.patch.yml`](provider/cordis.patch.yml).
It turns off three host capability rows and inserts sandbox-backed replacements:

| Row            | Before                      | After                                  |
| -------------- | --------------------------- | -------------------------------------- |
| `fs-sandbox`   | reads and writes your disk  | reads and writes the sandbox workspace |
| `bash-sandbox` | runs `bash` on your machine | runs `bash` in the sandbox             |
| `subprocess`   | spawns host processes       | spawns processes in the sandbox        |

It leaves every tool row alone, so the stock `standard` and `code` agent presets
keep working and simply point at the sandbox.

One tool is turned off. `glob` and `grep` come from `tool-fs-search`, which
spawns a ripgrep binary resolved from the dsh host's own `node_modules`. That
path does not exist inside the sandbox, so the tools would fail on every call.
Searching a remote filesystem needs a provider-side search backend that this
milestone does not have. The agent can still use `grep` and `find` through
`bash`.

### 4. Run dsh and open a session

`dsh web` starts a server. It does not start a session.

```sh
cd ~/code/your-repo     # only matters if you are relying on auto-detect
dsh web
```

It prints a `dsh web:` URL and opens your browser, unless you pass `--no-open`
or are on an SSH connection. `--port` and `--host` are there too. Sessions are
created from the browser, so open a new one there.

No sandbox exists until that point. The first session then pulls the runner
image, starts a container, clones the repository into `/workspace`, and runs
`.dsh/setup.sh` if the repository has one. Later sessions on a warm image start
in a few seconds.

If you are relying on auto-detect, the working directory a session resolves to
is the workspace you picked in the UI, and otherwise the directory you launched
dsh from. That directory decides which repository gets cloned. Setting
`repository` skips this question entirely.

Each dsh session gets its own sandbox. Two sessions never share files.

## Credentials and secrets

These never go in YAML, because a profile layer is a plain file and a chat
transcript is durable. They go through the package's own CLI, which
`dsh plugin add` puts here:

```sh
export DSH="$HOME/.dsh/profiles/web/node_modules/.bin/dsh-workbench"

export DSH_SANDBOX_GITHUB_CLIENT_ID=your-oauth-app-client-id
"$DSH" auth github                          # device-code flow, for private repos

printf '%s' "$API_KEY" | "$DSH" secret set API_KEY
"$DSH" secret list
```

Both the CLI and the plugin default to `~/.dsh-sandbox` for state. If you set
`stateDir` in YAML, set `DSH_SANDBOX_STATE_DIR` to the same path for the CLI, or
they will read different stores.

If GitHub authorization is missing when a session needs it, the provider puts
the device-code challenge into the conversation and waits.

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

| Path                                                        | What                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| `$DSH_HOME/profiles/<name>/cordis.patch.yml`                | every setting you configure                            |
| `$DSH_HOME/profiles/<name>/`                                | installed plugins and the profile's bundle list        |
| `$DSH_HOME/profiles/<name>/node_modules/.bin/dsh-workbench` | the CLI                                                |
| `~/.dsh-sandbox/`                                           | signing key, session records, broker store, owner-only |
| `/workspace` inside the sandbox                             | the cloned repository                                  |

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

## Kubernetes

### Pointing at a real cluster

Four things have to be true before `backend: kas` can work, and only the last
one is plugin configuration.

1. **The cluster runs agent-sandbox v0.5.4**, with a SandboxTemplate and a warm
   pool applied from `deploy/kubernetes/`. See
   [`docs/kubernetes.md`](docs/kubernetes.md).
2. **The runner image is pullable by the cluster**, substituted into the
   template in place of `DSH_RUNNER_IMAGE_PLACEHOLDER`.
3. **The provider's public key is deployed as a ConfigMap.** Warm pods are
   created before any session claims them, so the key has to be there before
   the first claim. Print it from the same `stateDir` dsh uses:

   ```sh
   "$DSH" key public
   ```

   The private key never leaves the dsh host.

4. **dsh runs where it can reach Sandbox service names.** A runner is only
   addressable in-cluster at `status.serviceFQDN:8080`, which is not an ingress
   and not a public URL, so a laptop cannot use this backend over the internet.

With all four in place, set `backend: kas` in your profile layer as shown in
[step 2](#2-choose-where-sandboxes-run).

The reference manifests use normal container isolation so they work in kind.
Hostile workloads need a stronger runtime such as gVisor and a network policy
suited to the cluster.

### Disposable dev cluster

From a checkout of this repository, these scripts create a kind cluster, check
warm claim, suspend, resume, volume persistence, and expiry, then remove it:

```sh
node provider/dist/cli.js key public > /tmp/dsh-provider.pub
scripts/kas/dev-cluster.sh \
  --runner-image dsh-runner:dev \
  --public-key-file /tmp/dsh-provider.pub \
  --load-runner-image
scripts/kas/smoke-test.sh
scripts/kas/teardown.sh
```

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
| `deploy/kubernetes/` | Reference warm pool, template, network policy, and RBAC                            |
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

For the Kubernetes lifecycle, use the
[disposable dev cluster](#disposable-dev-cluster) scripts.

To run a checkout instead of a release, build first and install the directory:

```sh
docker buildx bake dev --load
pnpm install && pnpm build
dsh plugin --profile web add "$PWD/provider"
```

Then point the manager at the locally built image in your profile layer:

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

Every release publishes two artifacts together: the `@zhming0/dsh-workbench`
package on npm, and a `ghcr.io/zhming0/dsh-runner` image built for `linux/amd64`
and `linux/arm64`. They share one version, and the provider defaults to the
image tag matching its own version, so the pair cannot drift.

Buildkite runs [`.buildkite/pipeline.yml`](.buildkite/pipeline.yml) on every
branch: provider checks and tests, runner tests, a check that the generated
protobuf code is current, and the Docker lifecycle smoke test.

On `main` a manual block step unlocks
[`.buildkite/pipeline.release.yml`](.buildkite/pipeline.release.yml), which picks
a calendar version, pushes the multi-architecture runner image, publishes the npm
package at the same version, and tags a GitHub release. The image is pushed
before the package so a published provider never names a tag that does not exist
yet.

## Milestone 1 boundaries

This release does not include interactive terminals, live streaming stdin,
service supervision, public service URLs, cross-sandbox child agents, or
sandbox-side `glob` and `grep`. It does support one-shot stdin, streamed output,
command cancellation, bounded background output, automatic idle hibernation,
wake, and final cleanup.
