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

The package declares a bundle patch, so `dsh plugin add` appends it to the
profile's layer stack and it applies on the next boot. The patch replaces three
host capability rows (`fs-sandbox`, `bash-sandbox`, `subprocess`) with
sandbox-backed ones, and turns off `tool-fs-search` because `glob` and `grep`
spawn a host ripgrep binary that does not exist inside the sandbox.

Tool rows are left alone, so the stock agent presets keep working and point at
the sandbox instead of the host.

In the Web profile, the package replaces directory picking with a repository
URL dialog. It creates an owner-only host anchor, registers it as a dsh
Workspace named `owner/repo`, and returns that path through dsh's normal picker
contract. dsh therefore sets the immutable session `cwd` before creation and
groups its history normally, while repository files remain inside the sandbox.

The Web profile also gains a **Secrets** manager at the sidebar foot, beside
Settings. It edits the same broker store as the CLI: the browser sends names
and values in and receives only names back, never a value.

The bundle also disables dsh's local shell permission presets. The remote shell
uses one fixed container boundary and does not claim to enforce those
per-command sandbox modes.

The default backend uses Docker on the same machine as dsh. The Kubernetes
backend uses Kubernetes SIG agent-sandbox and must run somewhere that can reach
in-cluster Sandbox service names.

## Settings

Configuration is YAML in the profile's own layer,
`$DSH_HOME/profiles/<name>/cordis.patch.yml`. A patch entry replaces the whole
`config` of the row it names, so restate the fields you want to keep.

```yaml
- id: sandbox-manager
  config:
    backend: docker
    idleMs: 300000
```

| Setting          | Default                 | Meaning                                             |
| ---------------- | ----------------------- | --------------------------------------------------- |
| `backend`        | `docker`                | `docker` or `kas`                                   |
| `repository`     | session repository      | Fallback repository for non-anchor sessions         |
| `revision`       | repository default      | Optional branch, tag, or commit to check out        |
| `workspace`      | `/workspace/repository` | Repository checkout and working directory           |
| `idleMs`         | 10 minutes              | Delay after a turn before hibernating               |
| `expiresAfterMs` | 7 days                  | How long a hibernated workspace is retained         |
| `stateDir`       | `~/.dsh-sandbox`        | Keys, records, broker data, and Workspace anchors   |
| `githubClientId` | none                    | GitHub OAuth app client ID for private repositories |
| `wipCommit`      | `false`                 | Make a local safety commit before hibernating       |
| `docker.image`   | matching release tag    | Runner image used by Docker                         |
| `docker.binary`  | `docker`                | Docker-compatible command                           |
| `kas.namespace`  | `dsh-sandbox`           | Namespace containing claims and warm sandboxes      |
| `kas.warmPool`   | `dsh-universal`         | Warm pool used for claims                           |
| `kas.kubeconfig` | normal client lookup    | Optional kubeconfig path                            |

For a Web Workspace created by this package, the repository URL stored in its
anchor takes precedence. Other sessions use `repository` when set, then run
`git remote get-url origin` in their host working directory. That fallback
auto-detection needs a local checkout; repository Workspaces do not.

Workspace anchors live beneath `stateDir/workspace-anchors`. Each contains only
`repository.json`; file and command tools map the host anchor to `workspace`
inside the sandbox. Anchors remain after sandbox expiry so historical dsh
Workspace registrations do not become missing directories.

Each release publishes a runner image tagged with the same version as this
package, and the provider defaults to that exact tag, so `docker.image` only
matters when testing a locally built image.

## CLI

Secrets and tokens never go in YAML, because a profile layer is a plain file and
a chat transcript is durable. They go through this package's CLI, which
`dsh plugin add` installs at
`$DSH_HOME/profiles/<name>/node_modules/.bin/dsh-workbench`.

```sh
dsh-workbench auth github
dsh-workbench secret list
printf '%s' VALUE | dsh-workbench secret set NAME
dsh-workbench secret delete NAME
dsh-workbench key public
```

It reads two environment variables and takes no flags:

| Variable                       | Default          | Meaning                               |
| ------------------------------ | ---------------- | ------------------------------------- |
| `DSH_SANDBOX_STATE_DIR`        | `~/.dsh-sandbox` | Must match the `stateDir` setting     |
| `DSH_SANDBOX_GITHUB_CLIENT_ID` | none             | GitHub OAuth app client ID for `auth` |

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

`auth github` is the alternative for operators who registered a GitHub OAuth
app: its device flow produces a user token that can reach every repository the
user granted to the app, not just the current one, and that token outranks
`GITHUB_TOKEN` when both exist. Skip GitHub credentials entirely if you only
work on public repositories.

## Credentials at rest

Provider state belongs on the dsh host, not in a sandbox. Files in `stateDir`
are created with owner-only permissions. The runner receives current values in
memory before it starts a command. Git credentials are served through a Unix
socket and are never written to the workspace.

## Kubernetes key setup

Kubernetes warm pods need the provider's public key before a session claims
them, because a pod exists before any session binds to it. Generate the key from
the same `stateDir` dsh uses:

```sh
dsh-workbench key public > /tmp/dsh-provider.pub
```

The private key never goes into Kubernetes. See
[`docs/kubernetes.md`](https://github.com/zhming0/dsh-sandbox/blob/main/docs/kubernetes.md).

## Milestone 1 limits

- `glob` and `grep` are turned off. Searching a remote filesystem needs a
  provider-side search backend, which does not exist yet.
- Interactive terminals and streaming subprocess input are not implemented.
  One-shot stdin, streamed stdout/stderr, cancellation, and background process
  handles are supported.
- Shell and subprocess output is kept in bounded in-memory tails. Truncated
  output is reported, but it is not copied to a spill file.
- Docker stop/start keeps the same container. Kubernetes suspension removes the
  pod and keeps its workspace volume.
- There is no service exposure or portal support yet.
