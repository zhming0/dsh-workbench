# dsh-workbench

A Kubernetes distribution of [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)
(dsh). You run one dsh host in your cluster. Each session claims its own
sandbox from a warm pool, and dsh's stock file and command tools work inside
that sandbox — never on the host. The host also holds the secrets and Git
credentials sandboxes need, so tokens live in one owner-only place instead of
in repositories or chat.

Running it takes three pieces of infrastructure, all yours to operate: a
Kubernetes cluster you administer,
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) (pinned to
**v0.5.4**; the install steps apply it), and an OIDC identity provider — dsh
ships no user authentication, so the distribution fronts it with oauth2-proxy
and you supply the OIDC client. If that is not your situation, this project is
not a turnkey tool.

The supported dsh surface is `dsh web`; headless mode never reaches the idle
lifecycle and is out of scope. A Docker-backend mode runs sessions in
containers on one machine, but it is the development path, not the product —
see [docs/development.md](docs/development.md).

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

While a session idles, the sandbox's pod is removed; its workspace volume
survives until expiry. In this repository, "sandbox" always means one such
provisioned environment.

## Getting started

The distribution is two images released together under one version:
`ghcr.io/zhming0/dsh-host` (dsh with the `web` profile and this provider
assembled) and `ghcr.io/zhming0/dsh-runner` (the per-sandbox server sessions
execute in). You need:

- a default StorageClass in the cluster;
- an OIDC client registered at your identity provider for
  [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/): issuer URL,
  client ID, and client secret;
- a repository for sandboxes to clone. Public repositories need nothing more;
  private ones need the GitHub step below.

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

# The shared registration token every runner presents when it dials the host.
kubectl -n dsh-sandbox create secret generic dsh-registration-token \
  --from-literal=token="$(openssl rand -hex 32)"

# Replace DSH_HOST_IMAGE_PLACEHOLDER and DSH_RUNNER_IMAGE_PLACEHOLDER with
# released tags, and dsh.example.com in host-oidc.yaml with your hostname.
kubectl apply -k deploy/kubernetes
```

The manifests stop at the proxy's pod port, 4180: put a Service and an
Ingress, LoadBalancer, or Gateway of your choosing in front of it. The proxy
authenticates users; it does not isolate them. One dsh host is one trust
domain: everyone the issuer admits shares the same sessions, credentials, and
sandboxes.

Runners dial out to the host's tunnel Service and authenticate with that
registration token, so no route into a sandbox is ever needed — rotation and
details are in
[docs/kubernetes.md](docs/kubernetes.md#the-in-cluster-dsh-host).

### Start a session

dsh signs a browser in with a per-process token; the browser exchanges it for
a cookie that lasts 30 days. The proxy has already authenticated you, so the
host hands the token over: open `/launch-token` through the address you use to
reach the host (`https://dsh.example.com/launch-token`, or
`http://localhost:3000/launch-token` over a port-forward) and it redirects you
to the tokenized URL. The token itself is also in the host log:

```sh
kubectl -n dsh-sandbox logs deploy/dsh-host | grep 'dsh web:'
# before exposure is wired up:
kubectl -n dsh-sandbox port-forward deploy/dsh-host 3000:3000
```

Then start a session:

1. Open **New session**, then **Add workspace…**.
2. Enter a repository URL such as `https://github.com/owner/repository`.
3. Choose the resulting Workspace and start the session.

The session claims a warm sandbox, clones the repository into
`/workspace/repository`, and runs `.dsh/setup.sh` if the repository has one.
The parent `/workspace` is the persistent volume root, so storage metadata such
as `lost+found` remains outside the checkout. Every session gets its own
sandbox; two sessions never share files.

### AGENTS.md instructions

Open **Settings → Instructions** to add AGENTS.md-style guidance without
changing a repository. Choose **Global** for every session or select a
repository Workspace for guidance that applies only to that repository.
Workspace instructions take precedence over the global layer. Checked-in
`AGENTS.md` files remain active, including more-specific files in nested
directories.

Saved changes apply to the next model request, usually after the next user
message or tool call, including in an existing session. They do not alter a
request already in flight. The host stores these UI-managed layers in
`stateDir/instructions.json`; it does not write into a checkout. Empty a scope
and save to clear it. The global and effective workspace layers may total at
most 65,536 UTF-8 bytes.

## Credentials and secrets

The host keeps a store of named secrets. Each one is injected into the
environment of every sandbox command, and one name is special: `GITHUB_TOKEN`
also serves as the Git credential for github.com, so cloning private
repositories needs nothing else. A fine-grained personal access token scoped
to the repositories you work on fits best; `gh auth token` works too.

Manage secrets in the Web UI — **Secrets**, at the sidebar foot next to
Settings — or with the CLI inside the host pod:

```sh
printf '%s' "$GITHUB_TOKEN" | kubectl -n dsh-sandbox exec -i deploy/dsh-host -- \
  dsh-workbench secret set GITHUB_TOKEN
```

Changes reach every session before its next command, running sessions
included. Never put secret values in the configuration file (plain YAML) or
in chat (transcripts are durable); the UI and CLI exist so values never touch
either. The full CLI is in [`provider/README.md`](provider/README.md#cli).

## Configuration

dsh composes a plugin tree at boot; a **profile** is one installed copy of
such a tree, and the host image seeds the `web` profile with this provider on
first boot. Your settings live in one file, the profile's override layer:
`/data/.dsh/profiles/web/cordis.patch.yml` in the host pod. There is no
UI for these deployment settings; the file is the interface. The Instructions
page described above manages only model guidance.

An entry replaces the **whole** `config` of the row it names rather than
merging into it, so restate every field you want to keep:

```yaml
- id: sandbox-manager
  config:
    profiles:
      standard:
        backend: kas
    idleMs: 300000 # hibernate after 5 minutes instead of 10
```

The file is watched, so a saved edit reaches the next session without
restarting dsh; `dsh --profile web --dump-config` prints the composed tree.
Every setting, with its default, is in
[`provider/README.md`](provider/README.md#settings).

## What changes for the agent

|                                               | Before                    | After                                  |
| --------------------------------------------- | ------------------------- | -------------------------------------- |
| `read`, `write`, `edit`, `str_replace_editor` | your disk                 | sandbox workspace                      |
| `bash`                                        | your machine              | sandbox                                |
| `glob`, `grep`                                | ripgrep on your machine   | sandbox workspace, ripgrep in the sandbox |
| Working directory                             | wherever you launched dsh | `/workspace/repository` in the sandbox |
| Session logs, attachments, spill files        | your disk                 | unchanged, still your disk             |

Replacing the filesystem row also turns off dsh's host-side permission model:
`workspace-write` and the approval prompts came from that row, and the bundle
drops the "Current DSH file policy" line from the agent's context with it. The
container is the boundary instead, and the agent acts inside it without asking
— treat the sandbox, not the prompt, as what stands between a repository and
your machine.

How the bundle patch does this — which rows it replaces, how `glob` and `grep`
come to run ripgrep inside the sandbox, and how a repository URL becomes a dsh
Workspace — is in
[`provider/README.md`](provider/README.md#what-installing-it-changes). To
sandbox only some sessions, use the agent preset in
[`examples/`](examples/agent.cordis.yml) instead of the bundle patch; the two
routes are alternatives, and running both gives a session two sandboxes.

## Trust boundaries

- The GitHub token and configured secrets stay in an owner-only directory on
  the dsh host.
- A runner keeps pushed credentials in memory. Its Git helper reads them from a
  private Unix socket, not from the workspace.
- Secret values are added only to child-process environments. Repository code
  can read them by design, so only run repositories trusted with those values.
- A GitHub token has whatever reach you grant it, so prefer a fine-grained
  PAT scoped to the repositories you work on. One provider instance suits one
  dsh user, not shared hosting.
- The runner dials out to the host and authenticates with a shared
  registration token; nothing ever connects into a sandbox. All RPCs flow
  host→runner over that runner-initiated tunnel, and the provider verifies the
  runner's sandbox identity before using it.

## Documentation

| Page                                         | Covers                                                           |
| -------------------------------------------- | ---------------------------------------------------------------- |
| [`docs/kubernetes.md`](docs/kubernetes.md)   | full install walkthrough, host operations, isolation, smoke test |
| [`provider/README.md`](provider/README.md)   | what the bundle patch changes, every setting, the CLI            |
| [`docs/development.md`](docs/development.md) | repository layout, build and test, checkout installs, releasing  |
