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
sandbox-backed ones, and replaces the stock `tool-fs-search` row with this
package's search backend, so `glob` and `grep` spawn ripgrep inside the sandbox
through its subprocess seam. The stock row resolves a ripgrep binary on the dsh
host, and no such path exists in a sandbox. Tool names, schemas, prompt
guidance, and caps are the stock ones; the search root is translated from the
session workspace to the sandbox workspace at the tool boundary.

The other tool rows are left alone, so the stock agent presets keep working and
point at the sandbox instead of the host. A preset that lists its own tool rows
gets `glob` and `grep` by loading the same row, `@zhming0/dsh-workbench/search`;
[`examples/`](../examples/agent.cordis.yml) shows it in place.

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
backend uses Kubernetes SIG agent-sandbox. Runners connect out to the host's
tunnel listener, so the host never dials into a sandbox; it only needs to be
reachable by the runners it manages.

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

| Setting             | Default                 | Meaning                                            |
| ------------------- | ----------------------- | -------------------------------------------------- |
| `backend`           | `docker`                | `docker` or `kas`                                  |
| `repository`        | session repository      | Fallback repository for non-anchor sessions        |
| `revision`          | repository default      | Optional branch, tag, or commit to check out       |
| `workspace`         | `/workspace/repository` | Repository checkout and working directory          |
| `idleMs`            | 10 minutes              | Delay after a turn before hibernating              |
| `expiresAfterMs`    | 7 days                  | How long a hibernated workspace is retained        |
| `stateDir`          | `~/.dsh-sandbox`        | Records, broker data, token, and Workspace anchors |
| `wipCommit`         | `false`                 | Make a local safety commit before hibernating      |
| `registrationToken` | see below               | Token(s) runners must present, comma-separated     |
| `tunnel.port`       | `8081`                  | Port the host listens on for runner tunnels        |
| `tunnel.bind`       | `0.0.0.0`               | Address the tunnel listener binds to               |
| `docker.image`      | matching release tag    | Runner image used by Docker                        |
| `docker.binary`     | `docker`                | Docker-compatible command                          |
| `docker.hostUrl`    | `host.docker.internal`  | `HOST_URL` runners dial, `tcp://` or `tls://`      |
| `kas.namespace`     | `dsh-sandbox`           | Namespace containing claims and warm sandboxes     |
| `kas.warmPool`      | `dsh-universal`         | Warm pool used for claims                          |
| `kas.kubeconfig`    | normal client lookup    | Optional kubeconfig path                           |

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

### Search

The `tool-fs-search` row comes from this package and configures the sandbox
`glob` and `grep` tools. It overrides by row id like any other:

```yaml
- id: tool-fs-search
  config:
    globMaxResults: 200
```

| Setting             | Default    | Meaning                                        |
| ------------------- | ---------- | ---------------------------------------------- |
| `globMaxResults`    | `100`      | Paths one `glob` call shows inline             |
| `grepMaxMatches`    | `250`      | Matches one `grep` call shows inline           |
| `grepMaxLineBytes`  | `2000`     | Byte cap per matched-line preview              |
| `rawOutputMaxBytes` | `20000000` | Complete raw `rg` stdout one search will parse |
| `timeoutMs`         | `30000`    | Cooperative budget for one search call         |
| `graceMs`           | `3000`     | Terminate-escalation grace after `timeoutMs`   |
| `stderrMaxBytes`    | `65536`    | Diagnostic tail retained from `rg` stderr      |

A result past its inline cap is truncated with a note; the complete result is
not saved to a spill file.

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

- `glob` and `grep` run ripgrep inside the sandbox through this package's
  search backend. A result past its inline cap is truncated with a note; the
  complete result is not copied to a spill file.
- Interactive terminals and streaming subprocess input are not implemented.
  One-shot stdin, streamed stdout/stderr, cancellation, and background process
  handles are supported.
- Shell and subprocess output is kept in bounded in-memory tails. Truncated
  output is reported, but it is not copied to a spill file.
- Docker stop/start keeps the same container. Kubernetes suspension removes the
  pod and keeps its workspace volume.
- There is no service exposure or portal support yet.
