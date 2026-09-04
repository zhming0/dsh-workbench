# dsh-workbench provider

This package connects DeepSeek Harness sessions to isolated environments. It
owns the sandbox lifecycle and supplies remote filesystem, shell, and subprocess
implementations to the normal dsh tools.

It ships pre-installed in the `ghcr.io/zhming0/dsh-host` image and is not
published to npm. For development, install a checkout:

```sh
dsh plugin --profile web add "$PWD/provider"
```

The [repository README](https://github.com/zhming0/dsh-workbench#getting-started)
covers the whole setup. This page is the reference: what the bundle patch does,
every setting, and the CLI.

## What installing it changes

The package declares a bundle patch. Once the package is installed in a
profile, dsh includes that patch in the layer stack on boot. It replaces three
host capability rows (`fs-sandbox`, `bash-sandbox`, `subprocess`) with
sandbox-backed ones. The tool rows are left alone: the stock tools keep their
names, schemas, prompt guidance, and caps, and reach the sandbox through those
three services without knowing one exists.

The stock `tool-fs-search` row (`glob`, `grep`) is the case that needs the
subprocess seam to translate paths, not just relay them. It spawns the host's
packaged `@vscode/ripgrep` binary with the session working directory and the
model's search root, all in host coordinates that do not exist in a sandbox.
The seam maps every path it can prove is the session workspace onto the sandbox
workspace — the workdir and any absolute argv element under the session
workspace — and resolves an executable path the sandbox cannot have to the
sandbox's own build of the same tool name (`rg` on the runner image). Anything
else in argv passes through unchanged. This is the same translation the shell
and filesystem seams apply to their paths, so a stock row that assumes the host
world runs against the sandbox whether the Web surface mounts it from a shipped
agent preset, a copied one, or the [`examples/`](../examples/agent.cordis.yml)
preset.

In the Web profile, the package replaces directory picking with a repository
URL dialog. It creates an owner-only host anchor, registers it as a dsh
Workspace named `owner/repo`, and returns that path through dsh's normal picker
contract. dsh therefore sets the immutable session `cwd` before creation and
groups its history normally, while repository files remain inside the sandbox.

The Web profile also replaces dsh's stock `@` file discovery
(`file-reference-local`). The stock row walks the session `cwd` on the host
filesystem, which here is the anchor directory above — it holds only
`repository.json`, so `@` would never see repository files. A
`sandbox-file-reference` row answers the same `fileReferences` service by
asking the runner to walk the sandbox workspace (one recursive `Tree` RPC per
refresh), and returns the same workspace-relative candidates with the same
exclusions and ranking as the stock provider. The listing is cached per
session and refreshed after the next tool result.

Typing `@` does not wake a hibernated sandbox. As a sandbox hibernates, the
manager walks its workspace once and saves the listing under
`<stateDir>/file-index/<session>.json`; a hibernated workspace cannot change,
because every write goes through a tool call that first wakes the sandbox, so
that saved listing is exact until the next wake. `@` on a hibernated session
reads it, and the file is removed with the session record. If no index exists
(the host restarted while the sandbox was running, or the walk failed), `@`
falls back to waking the sandbox.

The Web profile also gains a **Secrets** manager at the sidebar foot, beside
Settings. It edits the same broker store as the CLI: the browser sends names
and values in and receives only names back, never a value.

The **Settings → Instructions** page manages AGENTS.md-style guidance at two
scopes: one global layer and one layer for each repository Workspace. These
layers live in host state rather than in repository checkouts.

The bundle also disables dsh's local shell permission presets and its file
policy line. The remote shell uses one fixed container boundary and does not
claim to enforce those per-command sandbox modes. The policy line would tell
the model it may write under the session workspace and name that workspace by
its host anchor path, which does not exist inside the sandbox; the model only
ever needs sandbox paths, and it finds its working directory the way any shell
user does.

One module is not part of the bundle patch:
`@zhming0/dsh-workbench/launch-token`. Mounted as a row, it serves
`GET /launch-token`, which redirects the browser to dsh's tokenized login URL so
users behind an authenticating proxy never read the token from the host log. It
is not a sign-in: anyone who reaches dsh's port can use it, so the row is off by
default. The host image mounts it only when `DSH_HOST_LAUNCH_TOKEN_ROUTE=1`,
which the Kubernetes oauth2-proxy manifest sets. To mount it yourself, insert
the row in a patch layer:

```yaml
- insert:
    - id: sandbox-launch-token
      name: "@zhming0/dsh-workbench/launch-token"
```

The default backend uses Docker on the same machine as dsh. The Kubernetes
backend uses Kubernetes SIG agent-sandbox. Runners connect out to the host's
tunnel listener, so the host never dials into a sandbox; it only needs to be
reachable by the runners it manages.

A host can offer several **sandbox profiles**. A profile is a complete
description of one kind of sandbox: which backend provisions it and that
backend's settings, such as a runner image for Docker or a warm pool for
Kubernetes. When more than one profile is
configured, a chip in the composer's tool row lets the user pick one for a new
session. The sandbox is provisioned on the first prompt, not when the session
is created, so the choice can still change until then. Once a sandbox exists
the chip shows the profile in use and is disabled.

## Settings

Configuration is YAML in the profile's own layer,
`$DSH_HOME/profiles/<name>/cordis.patch.yml`. A patch entry replaces the whole
`config` of the row it names, so restate the fields you want to keep.

```yaml
- id: sandbox-manager
  config:
    profiles:
      standard:
        backend: docker
    idleMs: 300000
```

`profiles` is the one required setting.

| Setting             | Default                 | Meaning                                                          |
| ------------------- | ----------------------- | ---------------------------------------------------------------- |
| `profiles.<name>`   | required                | One sandbox profile; its fields are listed in the next table     |
| `defaultProfile`    | first profile           | Profile used when a session does not pick one                    |
| `repository`        | session repository      | Fallback repository for non-anchor sessions                      |
| `revision`          | repository default      | Optional branch, tag, or commit to check out                     |
| `workspace`         | `/workspace/repository` | Repository checkout and working directory                        |
| `idleMs`            | 10 minutes              | Idle delay after the last turn or wake before hibernating        |
| `expiresAfterMs`    | 7 days                  | How long a hibernated workspace is retained                      |
| `stateDir`          | `~/.dsh-sandbox`        | Records, broker data, token, instructions, and Workspace anchors |
| `wipCommit`         | `false`                 | Make a local safety commit before hibernating                    |
| `registrationToken` | see below               | Token(s) runners must present, comma-separated                   |
| `tunnel.port`       | `8081`                  | Port the host listens on for runner tunnels                      |
| `tunnel.bind`       | `0.0.0.0`               | Address the tunnel listener binds to                             |

Each profile carries the settings of its own backend. Profiles do not share
settings with each other, so two Kubernetes profiles in one namespace both
name that namespace.

| Profile field    | Backend  | Default                | Meaning                                        |
| ---------------- | -------- | ---------------------- | ---------------------------------------------- |
| `backend`        | both     | required               | `docker` or `kas`                              |
| `image`          | `docker` | matching release tag   | Runner image                                   |
| `binary`         | `docker` | `docker`               | Docker-compatible command                      |
| `hostUrl`        | `docker` | `host.docker.internal` | `HOST_URL` runners dial, `tcp://` or `tls://`  |
| `namespace`      | `kas`    | `dsh-sandbox`          | Namespace containing claims and warm sandboxes |
| `warmPool`       | `kas`    | `dsh-universal`        | Warm pool used for claims                      |
| `readyTimeoutMs` | `kas`    | 3 minutes              | How long to wait for a claimed sandbox         |
| `kubeconfig`     | `kas`    | normal client lookup   | Optional kubeconfig path                       |

For a Web Workspace created by this package, the repository URL stored in its
anchor takes precedence. Other sessions use `repository` when set, then run
`git remote get-url origin` in their host working directory. That fallback
auto-detection needs a local checkout; repository Workspaces do not.

Workspace anchors live beneath `stateDir/workspace-anchors`. Each contains only
`repository.json`; file and command tools map the host anchor to `workspace`
inside the sandbox. Anchors remain after sandbox expiry so historical dsh
Workspace registrations do not become missing directories.

Each release publishes a runner image tagged with the same version as this
package, and the provider defaults to that exact tag, so a Docker profile's
`image` only matters when testing a locally built image.

### Sandbox profiles

`profiles` is a map from profile name to a backend and that backend's
settings. A Kubernetes host with two pod sizes looks like this; each warm pool
must exist in the cluster (see [`docs/kubernetes.md`](../docs/kubernetes.md)):

```yaml
- id: sandbox-manager
  config:
    defaultProfile: standard
    profiles:
      standard:
        backend: kas
        warmPool: dsh-universal
      large:
        backend: kas
        warmPool: dsh-large
```

Profiles may mix backends, for example one Docker profile beside Kubernetes
ones. Every session record stores the profile name and backend it was
provisioned with. Removing a profile from the configuration keeps its existing
sessions readable, but they cannot wake until a profile with that name is
restored on the same backend. A session whose pending choice was removed falls
back to an error at its first prompt, asking the user to pick again.

### Search

`glob` and `grep` are the stock `@deepseek-ai/dsh-tool-fs-search` row, so
their caps are that package's settings, set where the row is mounted. On the
Web surface that is the agent preset, not this profile layer: shipped presets
restate the row by its stock name, and a preset copied from one carries the
same rows to edit.

### AGENTS.md instructions

The Web UI's **Settings → Instructions** page stores model guidance without
modifying a repository:

- **Global · All workspaces** applies to every session managed by this host.
- **Workspace · owner/repo** adds guidance only when that repository Workspace
  is selected. Workspace guidance takes precedence over the global layer.
- Checked-in `AGENTS.md` files still load normally. More-specific nested files
  take precedence when the agent works below their directory.

The current complete UI-managed baseline is added to durable model context on
the next model request, usually after the next user message or tool call. It
does not alter a request already in flight. If a setting changes, the new
baseline explicitly supersedes the previous one; clearing the last active
layer adds a corresponding removal notice. Literal `</system-reminder>` text
is escaped inside the provider-owned frame.

State is stored in the owner-only `stateDir/instructions.json` file, not in a
checkout. Global plus workspace content is limited to 65,536 UTF-8 bytes for
each effective workspace. Removing and later re-adding a Workspace with the
same normalized repository URL restores its saved layer.

## CLI

Secrets and tokens never go in YAML, because a profile layer is a plain file and
a chat transcript is durable. They go through this package's CLI, which
`dsh plugin add` installs at
`$DSH_HOME/profiles/<name>/node_modules/.bin/dsh-workbench`.

```sh
dsh-workbench secret list
printf '%s' VALUE | dsh-workbench secret set NAME
dsh-workbench secret delete NAME
```

It reads one environment variable and takes no flags:

| Variable                | Default          | Meaning                           |
| ----------------------- | ---------------- | --------------------------------- |
| `DSH_SANDBOX_STATE_DIR` | `~/.dsh-sandbox` | Must match the `stateDir` setting |

`secret set` refuses an interactive terminal so a value cannot end up in shell
history by accident. The provider reloads the broker file before the next
sandbox command, so CLI changes take effect without restarting dsh. The Web
UI's Secrets page edits the same store.

A secret named `GITHUB_TOKEN` doubles as the Git credential for github.com, so
`secret set GITHUB_TOKEN` with a fine-grained personal access token (or
`gh auth token`) is the simplest way to reach private repositories — no OAuth
app required.

Sandbox code can read injected secrets, which is their purpose. The broker
improves storage and cleanup, not confidentiality from the repository being run.
Skip `GITHUB_TOKEN` entirely if you only work on public repositories.

## Credentials at rest

Provider state belongs on the dsh host, not in a sandbox. Files in `stateDir`
are created with owner-only permissions. The runner receives current values in
memory before it starts a command. Git credentials are served through a Unix
socket and are never written to the workspace.

## Registration token

A runner authenticates its tunnel with a shared registration token, presented
in the connection handshake. The provider resolves the accepted tokens in this
order:

1. `registrationToken` in settings — comma-separated to accept several during
   rotation. The first token is the one injected into new sandboxes.
2. The `DSH_WORKBENCH_REGISTRATION_TOKEN` environment variable, same format.
3. Docker backend only: a token generated on first run and persisted at
   `stateDir/registration-token` with owner-only permissions. The Kubernetes
   backend refuses to start without an explicit token, because warm pods need
   the same token before any session claims them.

For Kubernetes, put the token in the `dsh-registration-token` Secret in the
sandbox namespace and in the host's environment. See
[`docs/kubernetes.md`](https://github.com/zhming0/dsh-workbench/blob/main/docs/kubernetes.md).

## Limits

- The subprocess seam translates a path argument only when it is a whole argv
  element under the session workspace. A session-frame path embedded in a
  `--flag=value` pair reaches the sandbox untranslated.
- Interactive terminals and streaming subprocess input are not implemented.
  One-shot stdin, streamed stdout/stderr, cancellation, and background process
  handles are supported. The shipped `minimal` agent preset is built on a
  terminal and also requires the disabled `sandbox-policy` service, so a
  session on that preset fails to compose; use `standard`, `code`, or `cordis`.
- Shell and subprocess output is kept in bounded in-memory tails. Truncated
  output is reported, but it is not copied to a spill file.
- Docker stop/start keeps the same container. Kubernetes suspension removes the
  pod and keeps its workspace volume.
- There is no service exposure or portal support yet.
