# dsh-workbench

A Kubernetes distribution of [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)
(dsh). You run one dsh host in your cluster. Each session claims its own
sandbox from a warm pool, and dsh's stock file and command tools work inside
that sandbox — never on the host.

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

# Replace DSH_HOST_IMAGE_PLACEHOLDER and DSH_RUNNER_IMAGE_PLACEHOLDER with
# released tags, and dsh.example.com in host-oidc.yaml with your hostname.
kubectl apply -k deploy/kubernetes
```

The manifests stop at the proxy's pod port, 4180: put a Service and an
Ingress, LoadBalancer, or Gateway of your choosing in front of it. The proxy
authenticates users; it does not isolate them. One dsh host is one trust
domain: everyone the issuer admits shares the same sessions, credentials, and
sandboxes.

Then publish the host's signing key. Warm runner pods read the trusted public
key when they start, so it must be published before the first claim — the
exact commands are in
[docs/kubernetes.md](docs/kubernetes.md#the-in-cluster-dsh-host).

### Start a session

Open the host in the browser (before exposure is wired up:
`kubectl -n dsh-sandbox port-forward deploy/dsh-host 3000:3000`), then:

1. Open **New session**, then **Add workspace…**.
2. Enter a repository URL such as `https://github.com/owner/repository`.
3. Choose the resulting Workspace and start the session.

The session claims a warm sandbox, clones the repository into `/workspace`,
and runs `.dsh/setup.sh` if the repository has one. Every session gets its own
sandbox; two sessions never share files.

## Credentials and secrets

Never put credentials in configuration: the configuration file is plain YAML,
and chat transcripts are durable. Use the distribution's CLI inside the host
pod:

```sh
kubectl -n dsh-sandbox exec -it deploy/dsh-host -- \
  env DSH_SANDBOX_GITHUB_CLIENT_ID=your-oauth-app-client-id \
  dsh-workbench auth github               # device-code flow, for private repos

printf '%s' "$API_KEY" | kubectl -n dsh-sandbox exec -i deploy/dsh-host -- \
  dsh-workbench secret set API_KEY
```

If GitHub authorization is missing when a session needs it, the provider puts
the device-code challenge into the conversation and waits. The full CLI is in
[`provider/README.md`](provider/README.md#cli).

## Configuration

dsh composes a plugin tree at boot; a **profile** is one installed copy of
such a tree, and the host image seeds the `web` profile with this provider on
first boot. Your settings live in one file, the profile's override layer:
`/data/.dsh/profiles/web/cordis.patch.yml` in the host pod. There is no
settings screen; the file is the interface.

An entry replaces the **whole** `config` of the row it names rather than
merging into it, so restate every field you want to keep:

```yaml
- id: sandbox-manager
  config:
    backend: kas
    idleMs: 300000 # hibernate after 5 minutes instead of 10
```

The file is watched, so a saved edit reaches the next session without
restarting dsh; `dsh --profile web --dump-config` prints the composed tree.
Every setting, with its default, is in
[`provider/README.md`](provider/README.md#settings).

## What changes for the agent

|                                               | Before                    | After                       |
| --------------------------------------------- | ------------------------- | --------------------------- |
| `read`, `write`, `edit`, `str_replace_editor` | your disk                 | sandbox workspace           |
| `bash`                                        | your machine              | sandbox                     |
| `glob`, `grep`                                | ripgrep on your machine   | unavailable; use `bash`     |
| Working directory                             | wherever you launched dsh | `/workspace` in the sandbox |
| Session logs, attachments, spill files        | your disk                 | unchanged, still your disk  |

Replacing the filesystem row also turns off dsh's host-side permission model:
`workspace-write` and the approval prompts came from that row. The container
is the boundary instead, and the agent acts inside it without asking — treat
the sandbox, not the prompt, as what stands between a repository and your
machine.

How the bundle patch does this — which rows it replaces, why `glob` and `grep`
are off, and how a repository URL becomes a dsh Workspace — is in
[`provider/README.md`](provider/README.md#what-installing-it-changes). To
sandbox only some sessions, use the agent preset in
[`examples/`](examples/agent.cordis.yml) instead of the bundle patch; the two
routes are alternatives, and running both gives a session two sandboxes.

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

## Milestone 1 boundaries

No interactive terminals, live streaming stdin, service supervision, public
service URLs, cross-sandbox child agents, or sandbox-side `glob` and `grep`.
One-shot stdin, streamed output, command cancellation, bounded background
output, idle hibernation, wake, and final cleanup all work. Details are in
[`provider/README.md`](provider/README.md#milestone-1-limits).

## Documentation

| Page                                           | Covers                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| [`docs/kubernetes.md`](docs/kubernetes.md)     | full install walkthrough, host operations, isolation, smoke test |
| [`provider/README.md`](provider/README.md)     | what the bundle patch changes, every setting, the CLI            |
| [`docs/development.md`](docs/development.md)   | repository layout, build and test, checkout installs, releasing  |
