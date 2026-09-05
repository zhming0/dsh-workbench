# Sandbox profiles

## Problem

One dsh host ran exactly one kind of sandbox. `backend: docker` or
`backend: kas` was a global switch, and the Kubernetes backend claimed from a
single warm pool, so every session on a host got the same resources and the
same runtime. Two needs break that model:

- More backends are coming. The first is a Buildkite Hosted Agent, where one
  build is one sandbox and the machine cannot pause or resume.
- Sessions need different sizes. A documentation fix and a full test-suite run
  should not both claim the largest pod the cluster offers.

The obvious places to hang that choice were wrong. Choosing a backend per
repository says "this repo runs on x, that repo runs on y", which is not how a
user thinks about it; the repository is what they work on, not where. Choosing
per agent preset ties compute to a prompt-and-tools composition that dsh owns
and that users switch for unrelated reasons. Neither gives the user a place to
say "this session, bigger".

## Decision

Introduce **sandbox profiles**: named options the operator defines in the
`sandbox-manager` settings. A profile is a backend plus that backend's full
settings — `image` and `hostUrl` for Docker, `namespace` and `warmPool` for
Kubernetes, later a pipeline for Buildkite. The backend is an attribute of the
profile, not a mode of the host.

The user picks a profile per session from a chip in the composer's tool row,
next to dsh's own access-mode select. The chip appears only when more than one
profile exists, so a plain install looks unchanged. The choice is pending until
the first prompt, which is when the sandbox is provisioned; after that the chip
shows the profile in use and is disabled. Previously `agent/session-start`
provisioned the sandbox as soon as a blank session existed, before the user
could have chosen anything, so provisioning moved to the first `agent/pre-step`.

Decided against:

- **Backend per repository or Workspace.** Wrong axis, as above. A repository
  anchor keeps recording only its URL.
- **Backend per agent preset.** Presets are a dsh Web UI composition selected
  for behavior; they would also need an isolate realm to publish their own
  `sandboxManager`, and every preset would then carry a full copy of the
  provider configuration.
- **A separate host per backend.** Works today, but the user has to know
  which URL to open before they know how big the job is.

## Configuration

`profiles` is required and replaces the old top-level `backend` switch and the
`docker:` and `kas:` blocks. Each profile is self-contained: it names its
backend and carries every setting that backend reads, with the backend's
defaults filling in what it leaves out. There is no shared per-backend layer to
inherit from, so a reader sees a profile's whole meaning in one place. The
seeded Kubernetes configuration declares one `standard` profile.

```yaml
- id: sandbox-manager
  config:
    defaultProfile: standard
    profiles:
      standard: { backend: kas, namespace: dsh-sandbox, warmPool: dsh-universal }
      large: { backend: kas, namespace: dsh-sandbox, warmPool: dsh-large }
      local: { backend: docker, image: dsh-runner:dev }
```

`defaultProfile` falls back to the first profile. The provider creates one
backend object per profile; a host with only Docker profiles still mints its
own registration token, any other backend still requires one to be configured.

## State

The session record gains `profile`, the name it was provisioned with. The
pending choice for a session without a sandbox lives in the same
`sessions.json` under `pendingProfiles` and is deleted when the record is
written. A record is orphaned when its profile name is gone from the
configuration or now points at a different backend. Orphaned records are kept,
not deleted: the operator may have removed the profile by mistake, and the
sandbox and its workspace still exist. The session cannot wake until a profile
with that name is configured on that backend again, and `initialize` warns
about it.

## Slice two: Buildkite

Built as `provider/src/backends/buildkite.ts`; operator documentation is
[`docs/buildkite.md`](../buildkite.md).

- A Buildkite profile is
  `{ backend: buildkite, organization, pipeline, hostUrl, [image, branch, readyTimeoutMs, tokenEnv] }`.
  Provision triggers a build on that pipeline through the Build API with
  `SANDBOX_ID`, `HOST_URL`, and `DSH_RUNNER_IMAGE` in the build env and the
  session id in build metadata, then polls until the build is `running`. The
  pipeline's one step is `docker run` of `$DSH_RUNNER_IMAGE` with those
  variables plus a `REGISTRATION_TOKEN` from a Buildkite secret. The image
  defaults to the host's release tag, as in the Docker profile, so host and
  runner stay in lock step without the operator editing the pipeline. The
  runner dials out as it does from Kubernetes.
- A build cannot pause. The backend reports `supportsHibernate: false`, and the
  manager treats that capability as "checkpoint instead": on idle it runs a
  script in the sandbox that commits the working tree and force-pushes `HEAD`
  to `dsh/wip/<session hash>` on `origin`, then cancels the build and keeps the
  record as hibernated with the checkpoint attached. The next prompt provisions
  a new build with the checkpoint branch as the setup revision, so
  `.agents/setup` sees the restored tree, then a second script moves the
  session back onto its branch, undoes the checkpoint commit, and deletes the
  branch. A failed push keeps the build running so the idle timer retries. The
  checkpoint lives in `provider/src/checkpoint.ts` and is not Buildkite
  specific; any backend without hibernation gets it.
- `wake` only answers the manager's recovery probe for a record still marked
  running: a live build is handed back, a finished one is reported missing so a
  replacement is provisioned. `hibernate` and `expireAt` throw, since the
  manager never calls them for this capability.
- Not done: telling the model its sandbox was replaced, so it re-runs
  environment setup it did by hand. Remote `dsh/wip/*` branches of expired
  sessions are not garbage collected.
- The trust boundary widens: a Buildkite API token and the organization's
  agent fleet join the host's trust domain. The token is ambient to the host
  process, read from `tokenEnv` (default `BUILDKITE_API_TOKEN`) at boot, the
  same way the Kubernetes backend uses the host pod's ServiceAccount. It is not
  a broker secret like `GITHUB_TOKEN`: the broker holds values pushed into
  sandboxes for the agent to use, and the Buildkite token must never reach a
  runner.
