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
covers the whole setup. This page is the reference: what the bundle patch does
and every setting.

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

Subagent sessions share the root session's sandbox. Every sandbox lookup keys
on the agent's top-level session — resolved from the durable `parentSession`
lineage of a child session header that carries `origin: subagent` — so
delegation reads and writes one working copy, a child's first tool call boots
the root's sandbox, and a child turn holds it against idle and release exactly
as a root turn does (turns are counted per key, so a parent and a child turning
at once keep the sandbox alive until both close). There is no locking or
conflict detection between a parent and its subagents; the sandbox boundary is
the containment. Resolution is memoized per session, so a child never switches
sandboxes when an ancestor is disposed mid-run; a child whose parent cannot be
resolved at all (absent or disposed ancestor) falls back to its own sandbox,
and the fallback is logged as a warning.

A Fork is not a subagent. dsh records a fork's source in the same
`parentSession` field, but a fork is a top-level session that owns a fresh
working copy, so it never shares the source's sandbox: starting a fork wakes
nothing and hibernating or releasing it leaves the source's sandbox alone. The
two are told apart by `origin`, which only a real subagent child sets. That
field is doing load-bearing work here even though dsh describes it as
presentation metadata, so a dsh change to how subagent children are marked
would silently cost delegation its shared working copy; see the risk note in
[`src/manager/root-session.ts`](src/manager/root-session.ts).

Uploaded attachments are copied into the sandbox on demand. dsh stores an
upload on the host and asks the filesystem row to map its host path into the
tool execution world; a sandbox shares no path with that host, so before each
model request the filesystem copies every attachment the request references
into `<workspace>/.dsh-attachments` and answers that mapping. Copies are keyed
by root session, so a subagent reads its root's copy, and they survive
hibernation because the workspace volume does. The mapping itself lives in
host memory, so the first request after a host restart copies again.

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

The Web profile also gains a **Settings → Secrets** page. It edits the
provider's broker store: the browser sends names and values in and receives
only names back, never a value.

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

The right sidebar's **Files** and **Preview** tabs and the file cards under
each turn (`workspace-files`, `ui-sidebar-files`, `ui-sidebar-documentpreview`,
`ui-deliverables`) read the session workspace through dsh's filesystem service
from plain browser requests, outside any agent turn, while this package's
filesystem finds a session's sandbox through the agent that is asking. The
bundle keeps those stock rows and adds two of its own: `sandbox-workspace-files`
wraps the live `workspaceFiles` service so each request runs as the agent of the
session it names, and `sandbox-workspace-policy` publishes the `sandboxPolicy`
service those rows require, reporting the sandbox workspace and adding nothing
to the prompt. Browsing a file behaves like any other request against the
session: it wakes a hibernated sandbox and counts as activity for the idle
timer. [`docs/plans/web-sidebar.md`](../docs/plans/web-sidebar.md) records why
the stock rows fail on their own and a deferred design in which browsing never
wakes a sandbox. One cosmetic limit remains: the Files tab's header label
comes from the session `cwd` in the browser, so it shows the host anchor
directory while every entry under it is a sandbox path.

The header's **Open in...** button (`open-in-app`, `ui-open-in-app`) is off:
it launches a desktop application on the host against the session `cwd`.
That `cwd` is the anchor, and the application probe would run through the
sandbox subprocess seam and report programs installed in the sandbox.

The bundle also corrects the model-facing system prompt. dsh's stock opener
names the session working directory in host coordinates — the anchor directory
above — and adds paragraphs about the host's dsh implementation checkout and
its Web GUI, none of which holds inside a sandbox. The `sandbox-context` row
shadows the `cwd` prompt variable with the sandbox workspace, contributes a
short environment section naming the sandbox mount and the GUI paragraph's
still-true claim about what "this page" means, and drops the host-only
checkout and GUI sections from the assembled prompt. The drop matches those
sections by their text, not by name or position, so it survives dsh refactors
of its prompt composition. If a dsh update rewords or removes those
paragraphs, the drop matches nothing, logs a warning once per host process,
and the sections ship unchanged while the environment section still states the
facts. Tests run the drop against an assembly built by the pinned
`@deepseek-ai/dsh-system-prompt` service, and a wording test downloads the
pinned composer packages (`@deepseek-ai/dsh-app-boot`, `@deepseek-ai/dsh-web-app`)
and fails CI when either paragraph changes, so a dsh bump cannot silently
reword them. The markers themselves are pinned to the observed wording.

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
backend uses Kubernetes SIG agent-sandbox. The Buildkite backend runs each
sandbox as one build on a pipeline you create. Runners connect out to the host's
tunnel listener, so the host never dials into a sandbox; it only needs to be
reachable by the runners it manages. The tunnel is a WebSocket, so an HTTPS
proxy or Ingress can carry it next to the Web UI; see
[Tunnel](#tunnel) below.

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

`profiles` may be empty. The host then boots and serves sessions normally,
but the first prompt fails with `no sandbox profile is configured` until a
profile is added; nothing is provisioned and no backend is contacted. That is
the intended state while installing the control plane before its sandbox
backend exists, and it keeps a mistyped profile map from stopping the host from
starting, so the settings can still be corrected.

| Setting             | Default                 | Meaning                                                          |
| ------------------- | ----------------------- | ---------------------------------------------------------------- |
| `profiles.<name>`   | none                    | One sandbox profile; its fields are listed in the next table     |
| `defaultProfile`    | first profile           | Profile used when a session does not pick one                    |
| `repository`        | session repository      | Fallback repository for non-anchor sessions                      |
| `revision`          | repository default      | Optional branch, tag, or commit to check out                     |
| `workspace`         | `/workspace/repository` | Repository checkout and working directory                        |
| `idleMs`            | 10 minutes              | Idle delay after the last turn or wake before hibernating        |
| `expiresAfterMs`    | 7 days                  | How long a hibernated workspace is retained                      |
| `stateDir`          | `~/.dsh-sandbox`        | Records, broker data, token, instructions, and Workspace anchors |
| `registrationToken` | see below               | Token(s) runners must present, comma-separated                   |
| `tunnel.port`       | `8081`                  | Port the host listens on for runner tunnels (see Tunnel)         |
| `tunnel.bind`       | `0.0.0.0`               | Address the tunnel listener binds to                             |

Each profile carries the settings of its own backend. Profiles do not share
settings with each other, so two Kubernetes profiles in one namespace both
name that namespace.

| Profile field    | Backend               | Default                | Meaning                                         |
| ---------------- | --------------------- | ---------------------- | ----------------------------------------------- |
| `backend`        | all                   | required               | `docker`, `kas`, or `buildkite`                 |
| `image`          | `docker`, `buildkite` | matching release tag   | Runner image                                    |
| `binary`         | `docker`              | `docker`               | Docker-compatible command                       |
| `hostUrl`        | `docker`, `buildkite` | `host.docker.internal` | `HOST_URL` runners dial, `ws://` or `wss://`    |
| `namespace`      | `kas`                 | `dsh-sandbox`          | Namespace containing claims and warm sandboxes  |
| `warmPool`       | `kas`                 | `dsh-universal`        | Warm pool used for claims                       |
| `readyTimeoutMs` | `kas`                 | 3 minutes              | How long to wait for a claimed sandbox          |
| `kubeconfig`     | `kas`                 | normal client lookup   | Optional kubeconfig path                        |
| `organization`   | `buildkite`           | required               | Buildkite organization slug                     |
| `pipeline`       | `buildkite`           | required               | Pipeline slug whose job runs the runner         |
| `hostUrl`        | `buildkite`           | required               | `HOST_URL` runners dial; agents are never local |
| `readyTimeoutMs` | `buildkite`           | 10 minutes             | How long a build may wait for an agent          |
| `tokenEnv`       | `buildkite`           | `BUILDKITE_API_TOKEN`  | Host variable holding the API token             |

A Buildkite profile cannot hibernate, so it checkpoints on idle (see below).
The host process needs the API token in `tokenEnv` at boot, with `read_builds`
and `write_builds` on the pipeline. The pipeline shape, the registration token,
and the limits are described in
[`docs/buildkite.md`](https://github.com/zhming0/dsh-workbench/blob/main/docs/buildkite.md).

### Archived sessions

Archiving a session in the Web UI is one-way: dsh keeps the session log but
offers no unarchive, so the session can never run again. When the host's
workspace registry reports an archived session, this provider destroys that
session's sandbox — container or claim, workspace storage included — and drops
its record, instead of holding both until `expiresAfterMs`. Subagent sessions
share the root session's sandbox, so releasing the root releases the whole
subagent tree; the children could not resume afterward anyway, because the
sidebar hides subagent-origin sessions. Commit and push work you still need
before archiving; the release also waits out a turn that is still running,
whatever session in the tree opened it. Outside the Web profile no workspace
registry exists, and sessions stay on the ordinary idle and expiry path.

For a Web Workspace created by this package, the repository URL stored in its
anchor takes precedence. Other sessions use `repository` when set, then run
`git remote get-url origin` in their host working directory. That fallback
auto-detection needs a local checkout; repository Workspaces do not.

Workspace anchors live beneath `stateDir/workspace-anchors`. Each contains only
`repository.json`; file and command tools map the host anchor to `workspace`
inside the sandbox. Anchors remain after sandbox expiry so historical dsh
Workspace registrations do not become missing directories.

Each release publishes a runner image tagged with the same version as this
package, and the provider defaults to that exact tag, so a profile's `image`
only matters when testing a locally built image. A Buildkite profile passes it
to the build as `DSH_RUNNER_IMAGE`; the pipeline step runs that image.

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

With an empty map the host still boots, and sessions, history, secrets,
instructions, and repository workspaces all keep working; only provisioning
fails, and its error names the missing setting. Add a profile to the
`sandbox-manager` row, then send the prompt again.

### Idle and hibernation

After `idleMs` without a turn the session's sandbox is put away and the
`expiresAfterMs` countdown starts. What "put away" means depends on the
backend:

- Docker and Kubernetes hibernate: compute stops, the workspace stays, and the
  next prompt wakes the same sandbox. Docker starts the container it stopped,
  so its whole filesystem is still there; Kubernetes builds a new pod around
  the surviving workspace volume.
- A backend that cannot hibernate checkpoints instead. The manager commits the
  Git working tree inside the sandbox (as `dsh <dsh@localhost>`, only if there
  are changes), writes the commits that `origin`'s default branch does not
  have to a Git bundle, stores that bundle under `stateDir/checkpoints/` on
  the host, and then destroys the sandbox. Nothing is pushed. The next prompt
  provisions a fresh sandbox, clones and runs `.agents/setup` as for a new
  session, unpacks the bundle, checks the original branch out at the saved
  commit, and undoes the checkpoint commit so the changes are uncommitted once
  more. The bundle is deleted once the restore succeeds.

A checkpoint keeps the checked-out branch, its commits (pushed or not), and
every tracked or untracked file that is not ignored. It does not keep ignored
files, installed packages, anything outside the repository, other local
branches, stashes, or which changes were staged: everything comes back
unstaged. A merge or rebase that was stopped on conflicts comes back as the
conflicted files with their markers, no longer mid-merge. `.agents/setup` runs
before the restore, on the configured revision, as it does for a new session.
The first prompt after a restore carries a notice that says the sandbox was
recreated from a checkpoint: Git changes and commits are back, while installed
tools, ignored files, and anything outside the repository are gone, and
previously staged changes are now unstaged, so the model can re-run the setup
steps it needs.

A wake carries its own one-shot notice on the first prompt, worded for what the
machine kept. On Kubernetes the new pod kept only the workspace volume, so the
notice names running processes, `/tmp`, and anything installed outside
`/workspace` as gone; the home directory lives on that volume and comes back
with it. On Docker the files survived and the notice says only that the
processes did not. Only a backend that hibernates sends this notice: a backend
that checkpoints never wakes, so its first prompt after a restore is the only
one that carries a note.

The bundle lives in the host's state directory next to the credential store,
with the same file permissions, so a checkpoint has the same exposure as a
hibernated sandbox's disk and needs no write access to the repository. The
bundle only carries commits the remote's default branch does not have; when
the clone has no `origin/HEAD` it carries the whole history instead. A bundle
over 64 MiB fails the checkpoint.

If the save fails the sandbox stays up, the host logs a warning, and the idle
timer retries after another `idleMs`. If the restore fails, the new sandbox is
destroyed and the next prompt tries again from the same bundle; a bundle that
was removed from the state directory produces an error on every prompt until
the session is released. A session that expires while checkpointed loses its
bundle with its record.

The session record says "checkpointed" from the moment the bundle is on host
disk until a fresh sandbox has been provisioned and restored. A host crash
inside either window therefore keeps the work: the next prompt restores from
the bundle. The cost is a sandbox the host no longer knows about, the one it
was about to destroy or the one it was restoring into. Only the backend's own
limits, such as a job timeout, reclaim it.

The Buildkite backend checkpoints; Docker and Kubernetes hibernate.

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

## Secrets

Secrets and tokens never go in YAML, because a profile layer is a plain file
and a chat transcript is durable. They go through the Web UI's
**Settings → Secrets** page, which stores them in the broker file under
`stateDir`.

The provider reloads the broker file before the next sandbox command, so a
saved change takes effect without restarting dsh.

A secret named `GITHUB_TOKEN` doubles as the Git credential for github.com, so
storing a fine-grained personal access token (or `gh auth token`) under that
name is the simplest way to reach private repositories — no OAuth app
required.

Sandbox code can read injected secrets, which is their purpose. The broker
improves storage and cleanup, not confidentiality from the repository being run.
Skip `GITHUB_TOKEN` entirely if you only work on public repositories.

On the Kubernetes distribution the same store lives on the host pod's data
volume; [`docs/credentials.md`](../docs/credentials.md) is the install-facing
page, including the credentials that deliberately never enter this store.

## Credentials at rest

Provider state belongs on the dsh host, not in a sandbox. Files in `stateDir`
are created with owner-only permissions. The runner receives current values in
memory before it starts a command. Git credentials are served through a Unix
socket and are never written to the workspace.

## Tunnel

Runners reach the host by opening a WebSocket at `/tunnel` on the tunnel
listener (`tunnel.port`, default 8081). The upgrade request carries the
registration token as a bearer token and the runner's sandbox ID in the
`X-Dsh-Sandbox-Id` header; the host answers a refusal with a plain HTTP
status (401 bad token, 409 sandbox already registered) and an acceptance with
101, after which the WebSocket carries HTTP/2 with the roles reversed: the
host is the HTTP/2 client and the runner the server. `GET /healthz` on the
same port answers 200 so an HTTP load balancer can health-check it.

The listener itself is plaintext. A runner inside the trust domain, such as a
Kubernetes sandbox in the host's cluster, dials it directly with
`ws://host:8081/tunnel`. A runner that reaches the host over a network you do
not control must dial `wss://`, with TLS terminated by the same HTTPS proxy or
Ingress that fronts the Web UI: route one path (`/tunnel`) of that hostname
to the tunnel port and hand runners `wss://<hostname>/tunnel`. No second
certificate, port, or listener is involved, and the proxy's authentication
layer must not sit on that path; the registration token is the tunnel's
authentication. Runners trust the system CA bundle, so a private CA has to be
made available to the runner process, for example through `SSL_CERT_FILE`.

Every proxy on the path must pass WebSocket upgrades and keep a connection
open for as long as a session lasts. Idle timeouts are satisfied by the
host's HTTP/2 pings every 30 seconds, but a maximum connection lifetime is
not: when the proxy cuts the tunnel, the RPC in flight fails and the runner
redials within seconds. Raise such limits to hours where the proxy has them.

## Registration token

A runner authenticates its tunnel with a shared registration token, presented
in the connection handshake. The provider resolves the accepted tokens in this
order:

1. `registrationToken` in settings — comma-separated to accept several during
   rotation. The first token is the one injected into new sandboxes.
2. The `DSH_WORKBENCH_REGISTRATION_TOKEN` environment variable, same format.
3. Docker backend only: a token generated on first run and persisted at
   `stateDir/registration-token` with owner-only permissions. The Kubernetes
   and Buildkite backends refuse to start without an explicit token, because
   the sandbox side holds the token before any session exists: warm pods from
   a Secret, Buildkite jobs from the pipeline's own secret store.

For Kubernetes, put the token in the `dsh-registration-token` Secret in the
sandbox namespace and in the host's environment. See
[`docs/kubernetes.md`](https://github.com/zhming0/dsh-workbench/blob/main/docs/kubernetes.md).
For Buildkite, the pipeline step passes it to the job as `REGISTRATION_TOKEN`;
see
[`docs/buildkite.md`](https://github.com/zhming0/dsh-workbench/blob/main/docs/buildkite.md).

## Limits

- The subprocess seam translates a path argument only when it is a whole argv
  element under the session workspace. A session-frame path embedded in a
  `--flag=value` pair reaches the sandbox untranslated.
- Interactive terminals and streaming subprocess input are not implemented.
  One-shot stdin, streamed stdout/stderr, cancellation, and background process
  handles are supported. The shipped `minimal` agent preset is built on a
  persistent terminal, so its only tool fails on every call; use `standard`,
  `code`, or `cordis`.
- Shell and subprocess output is kept in bounded in-memory tails. Truncated
  output is reported, but it is not copied to a spill file.
- An uploaded attachment reaches the sandbox through one unary `WriteFile` RPC
  that both sides buffer in memory, so copies are capped at 64 MiB per file. A
  larger upload keeps dsh's "cannot access a readable path" placeholder;
  chunked transfer is not implemented.
- Docker stop/start keeps the same container. Kubernetes suspension removes the
  pod and keeps its workspace volume.
- There is no service exposure or portal support yet.
