# Buildkite backend

The Buildkite backend runs one sandbox as one build on a pipeline you own. The
provider triggers the build through the Build API and tells the job which
sandbox it is, where to dial, and which runner image to run; your pipeline
supplies the registration token. The job then runs `dsh-runner` until the
session goes idle, when the provider saves the working tree as a checkpoint on
the host and cancels the build. No agent, queue, or image is created on your behalf.

This backend is a development path, like Docker. It is unit tested against a
fake of the Build API; the pipeline examples below have not been run end to end
against a Buildkite agent fleet. Treat them as the intended shape and watch the
first build in your own organization.

## What the host does

```text
┌──────────┐  POST /builds {env: SANDBOX_ID, HOST_URL,   ┌───────────┐
│          │               DSH_RUNNER_IMAGE}             │           │
│ dsh host │────────────────────────────────────────────▶│ Buildkite │
│          │◀── GET /builds/{n} until state == running ──│    API    │
│  tunnel  │                                             └─────┬─────┘
│  :8081   │                                                   │ job
│          │◀────── dsh-runner dials HOST_URL ───────────┌──────┴─────┐
└──────────┘        with REGISTRATION_TOKEN              │   agent    │
                                                         └────────────┘
```

For each new session the provider:

1. looks for a live build tagged with the session (`meta_data[dsh-session]`),
   in case the host stopped after creating one and before saving its record;
2. otherwise creates a build with `commit: HEAD` on a branch named after the
   sandbox, build env `SANDBOX_ID`, `HOST_URL`, and `DSH_RUNNER_IMAGE`, and
   that session tag;
3. polls the build until its state is `running`, giving up and cancelling the
   build after `readyTimeoutMs` (default 10 minutes); this covers queue wait and
   image pull, after which the runner has 60 seconds to register on the tunnel.

`SANDBOX_ID` is `dsh-<16 hex chars of the session hash>-<6 random hex chars>`.
The random suffix changes on every build, so a runner from a cancelled job
that is still redialing cannot be mistaken for the new one. The build's branch
is the same string. Buildkite does not check that a branch exists, and the
pipeline's repository has nothing to do with the sandbox, so the branch is
only a label; giving every sandbox its own keeps the pipeline's per-branch
settings ("skip queued intermediate builds", "cancel running intermediate
builds") from ever acting on another session's sandbox.

## Idle: checkpoint, cancel, restore

A Buildkite job cannot pause, so there is no hibernation. Instead, when the
session goes idle the provider checkpoints the sandbox's Git working tree
before it cancels the build: it commits the tree inside the sandbox (only if
there are changes), writes the commits that `origin`'s default branch does not
have to a Git bundle, and pulls that bundle out over the tunnel into the host's
`stateDir/checkpoints/`. Nothing is pushed to the repository and no Git write
access is needed. The build is cancelled only after the bundle is on the host;
if the save fails the build keeps running and the idle timer retries. The
session record stays, marked checkpointed, and `expiresAfterMs` starts
counting.

On the next prompt the provider triggers a new build, the runner clones the
repository and runs `.agents/setup` exactly as for a new session, and the
provider then unpacks the bundle and puts the session back where it was: the
original branch at the same commit (or a detached `HEAD`), with the checkpoint
commit undone so the changes are uncommitted once more.

Only the Git working tree is saved. Ignored files, installed packages, tool
versions from `mise install`, and anything outside the repository are gone when
the build is cancelled. Put that setup in `.agents/setup` so the next build
reproduces it. The full contract, including what a checkpoint does and does
not keep and the 64 MiB bundle cap, is in the provider README under "Idle and
hibernation".

The host polls the build state when a session resumes. A build that has
finished or been cancelled outside dsh is reported as missing and the session
gets a replacement build under the same profile.

## Host configuration

```yaml
- id: sandbox-manager
  config:
    registrationToken: <shared with the pipeline>
    tunnel:
      port: 8081
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-sandbox
        hostUrl: tls://dsh.example.com:8081
```

| Field            | Default               | Meaning                                                                  |
| ---------------- | --------------------- | ------------------------------------------------------------------------ |
| `organization`   | required              | Organization slug, as in `buildkite.com/<organization>`                  |
| `pipeline`       | required              | Pipeline slug                                                            |
| `hostUrl`        | required              | Tunnel endpoint the runner dials, `tcp://host:port` or `tls://host:port` |
| `image`          | matching release tag  | Runner image the job runs, sent to the build as `DSH_RUNNER_IMAGE`       |
| `readyTimeoutMs` | `600000`              | How long a build may sit `scheduled` before the provider cancels it      |
| `tokenEnv`       | `BUILDKITE_API_TOKEN` | Environment variable on the host that holds the API token                |

The host process must have, at boot:

- the API token in `tokenEnv`, an [API access token](https://buildkite.com/docs/apis/managing-api-tokens)
  for the organization with the `read_builds` and `write_builds` scopes. The
  provider refuses to start a Buildkite profile without it. The token stays in
  the host process; it is never sent to a build or a runner.
- the registration token, in `registrationToken` or
  `DSH_WORKBENCH_REGISTRATION_TOKEN`. The backend does not generate one because
  the pipeline must hold the same value.

`hostUrl` must be reachable from Buildkite agents, which are never on the host
machine. The tunnel is plain TCP; put TLS in front of it and use `tls://`
whenever the agents reach it over a network you do not control. Hosted agents
always do.

## The pipeline

Create a pipeline with these steps in the Buildkite pipeline editor. One
command step is all it needs. The provider never uploads steps: the pipeline's
own definition is the whole contract.

```yaml
steps:
  - label: dsh sandbox
    command: >-
      docker run --rm
      -e SANDBOX_ID -e HOST_URL -e REGISTRATION_TOKEN
      "$DSH_RUNNER_IMAGE"
    checkout:
      skip: true
    secrets:
      REGISTRATION_TOKEN: dsh_registration_token
    timeout_in_minutes: 240
    agents:
      queue: hosted
```

- The command runs the runner image the host named in `DSH_RUNNER_IMAGE`. The
  host and runner are released together and the provider defaults to the tag
  matching its own version, so the pipeline never pins an image and cannot
  drift from the host. `-e VAR` with no value copies that variable from the
  job environment: `SANDBOX_ID` and `HOST_URL` come from the build env the
  provider set, `REGISTRATION_TOKEN` from `secrets`. The image's entrypoint is
  `dsh-runner`. Docker is present on Buildkite hosted Linux agents and on any
  self-hosted agent you give it to.
- `agents.queue` picks the fleet a sandbox runs on, and it has to be set here:
  steps defined in the pipeline editor interpolate only a fixed list of
  `BUILDKITE_*` variables, before the build exists, so a variable in the build
  env cannot choose the queue. To offer two fleets, create two pipelines and
  point two profiles at them.
- `checkout: { skip: true }` stops the agent from cloning the pipeline's own
  repository. The runner clones the session's repository itself, into
  `/workspace/repository` inside the container, with credentials the host
  pushes over the tunnel. The pipeline's repository setting is irrelevant to
  the sandbox; point it at any repository the agent may read, or an empty one.
- `secrets` maps a [Buildkite secret](https://buildkite.com/docs/pipelines/security/secrets/buildkite-secrets)
  into the job environment. Create the `dsh_registration_token` secret in the
  cluster the agents belong to, with the same value the host uses. This needs
  agent 3.106.0 or later. A pipeline environment variable would also work but
  is stored in plain text on the pipeline.
- `timeout_in_minutes` bounds a sandbox's life even if the host never cancels
  it. The provider cancels on idle, so this is a backstop. Buildkite applies
  its own ceiling on top: the Personal plan caps a job at 4 hours, hosted
  agents at 8 hours unless Buildkite support raises it, and an organization or
  pipeline may set a maximum command step timeout.

The pipeline should not trigger builds on its own. Turn off the repository
webhook, or leave the pipeline without a repository integration, so the only
builds are the ones the provider creates. A build that Buildkite starts by
itself has no `SANDBOX_ID` or `HOST_URL` in its env, so `dsh-runner` exits at
once and the job fails; it wastes an agent slot but never reaches the host.

## Trust boundary

One dsh host is one trust domain, and a Buildkite profile widens it:

- The API token can create and cancel builds on the pipeline. Anyone who can
  read the host's environment can trigger jobs on your agents.
- Every agent that can take the job, and every person who can edit the
  pipeline's steps, can read `REGISTRATION_TOKEN` and the secrets the host
  pushes to the runner after it registers. Give the pipeline its own cluster
  and queue rather than sharing them with unrelated CI.
- The job runs with whatever the agent grants it. On hosted agents that is a
  Buildkite-managed VM; on self-hosted agents it is your infrastructure.
- The idle checkpoint bundle lives in the host's state directory, next to the
  credential store, so a checkpointed session's work has the same exposure as a
  hibernated sandbox's disk.

## Limits

- No hibernation. Idle saves the Git working tree as a bundle on the host and
  cancels the build; everything else in the sandbox is lost. The first prompt
  after the restore tells the model what did not come back.
- A build is polled every two seconds while waiting for an agent. With a busy
  self-hosted queue, raise `readyTimeoutMs`.
- `health` is a Build API read on every resume of a session whose tunnel has
  dropped. Buildkite's REST rate limit applies to the API token.
- Build states are read from the Build API, not from the job. A build whose
  single job has failed shows `failed`; a build blocked by a step the pipeline
  should not have is treated as never starting and cancelled at the timeout.
