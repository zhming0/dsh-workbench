# Runner on a Buildkite agent

Each sandbox is one build on a Buildkite pipeline you own: the host triggers
the build, the agent runs the runner container, and the runner dials back over
the tunnel. Pick this when sessions should run outside the cluster. The
backend's internals are in [`buildkite.md`](buildkite.md).

Install the [control plane](installations-control-plane.md) first.

## Prerequisites

- a Buildkite organization and permission to create a pipeline, an
  [API access token](https://buildkite.com/docs/apis/managing-api-tokens) with
  the `read_builds` and `write_builds` scopes, and agents that can run Docker.
  Docker is present on hosted Linux agents and on any self-hosted agent you
  give it to.
- the tunnel reachable from wherever those agents run. Agents are never on the
  host machine, so an in-cluster address will not do; see
  [Reaching the tunnel](#reaching-the-tunnel) below.

## Create the pipeline

Create a pipeline with this one command step. The provider never uploads
steps: the pipeline's own definition is the whole contract.

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

- `DSH_RUNNER_IMAGE`, `SANDBOX_ID`, and `HOST_URL` come from the build
  environment the provider sets, so the pipeline never pins a runner image and
  cannot drift from the host.
- `secrets` maps a [Buildkite secret](https://buildkite.com/docs/pipelines/security/secrets/buildkite-secrets)
  into the job environment. Create `dsh_registration_token` with the same value
  the host holds — the `dsh-registration-token` Secret in the cluster — so the
  runner can register on the tunnel. This needs agent 3.106.0 or later.
- `agents.queue` has to be set here rather than from the build environment:
  pipeline steps interpolate only a fixed list of `BUILDKITE_*` variables,
  before the build exists. To offer two fleets, create two pipelines and point
  two profiles at them.
- `timeout_in_minutes` bounds a sandbox's life even if the host never cancels
  it; the provider cancels on idle. Buildkite applies its own ceilings on top.
- The pipeline should not trigger builds on its own. Turn off its repository
  webhook, or leave it without a repository integration, so the only builds are
  the ones the provider creates.

[`buildkite.md`](buildkite.md#the-pipeline) explains each of these in full.

## Point the host at the pipeline

```yaml
# dsh-workbench.values.yaml
provider:
  sandboxManager:
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-sandbox
        hostUrl: wss://dsh.example.com/tunnel
host:
  extraEnv:
    - name: BUILDKITE_API_TOKEN
      valueFrom:
        secretKeyRef:
          name: dsh-buildkite
          key: token
```

Put the token in that Secret first, as
[control-plane credentials](installations-control-plane.md#credentials)
describes, then upgrade:

```sh
helm upgrade dsh-workbench oci://ghcr.io/zhming0/charts/dsh-workbench \
  --namespace dsh-sandbox \
  --values dsh-workbench.values.yaml
```

The token is read at boot and never sent to a build, and it does not go in the
provider's secret store. Then run a session: the provider creates a build, an
agent picks it up, and the sandbox is live once its runner registers.

## Reaching the tunnel

An HTTP Ingress that passes WebSocket upgrades can carry the tunnel — one
`/tunnel` path rule on the Ingress that fronts the Web UI, under the same
certificate. An endpoint you expose separately has to be L4: a TCP stream proxy
or a Gateway API `TLSRoute` in passthrough mode. Never put an HTTP-terminating
proxy or CDN in the path.
[`kubernetes.md`](kubernetes.md#exposing-the-runner-tunnel-beyond-the-cluster)
has the shapes and constraints. Exposure changes reachability, not trust: the
registration token still authenticates every runner.

## Several fleets

`agents.queue` is per pipeline, so a second fleet is a second pipeline and a
second profile. That is also how a session gets a choice between sandbox
places; the composer shows a profile chip when more than one exists:

```yaml
- id: sandbox-manager
  config:
    defaultProfile: hosted
    profiles:
      hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-sandbox
        hostUrl: wss://dsh.example.com/tunnel
      self-hosted:
        backend: buildkite
        organization: acme
        pipeline: dsh-sandbox-self-hosted
        hostUrl: wss://dsh.example.com/tunnel
```

## Next

[`credentials.md`](credentials.md) gives sessions their credentials,
`GITHUB_TOKEN` first.
