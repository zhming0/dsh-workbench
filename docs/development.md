# Development

How to build and test dsh-workbench, run it from a checkout, and cut a
release. For what the project is and how to deploy it, start with the
[README](../README.md).

## Repository layout

| Path                 | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `provider/`          | TypeScript dsh plugin, bundle patch, lifecycle policy, backends, credential broker |
| `runner/`            | Go server that runs inside each sandbox                                            |
| `proto/`             | Single ConnectRPC contract used by provider and runner                             |
| `deploy/kubernetes/` | Warm pool, template, network policy, RBAC, host Deployment, oauth2-proxy patch    |
| `scripts/kas/`       | Disposable kind cluster and lifecycle smoke test                                   |
| `examples/`          | Agent preset for the per-session route                                             |

## Build and test

[`mise.toml`](../mise.toml) pins Node, Go, and the protobuf plugins. CI
installs from the same file, so a build and a laptop agree by construction.
Install [mise](https://mise.jdx.dev), then:

```sh
mise install
corepack enable pnpm
```

pnpm is the one exception: the `packageManager` field in `package.json` pins
it, and corepack reads that field. Buf arrives with `pnpm install`. Docker is
needed for the end-to-end local test.

```sh
pnpm install
pnpm check
pnpm test
pnpm build

(cd runner && go test -race ./... && go vet ./... && go build ./cmd/dsh-runner)
docker buildx bake dev --load
pnpm test:docker
docker buildx bake dev host-dev --load
pnpm test:kas
```

`docker buildx bake dev` builds the runner image for the current machine; the
release build covers `linux/amd64` and `linux/arm64`. The Docker smoke test
checks runner registration, secret injection, the bundled command-line tools,
first-run setup, and file survival across stop/start. The Kubernetes test
creates a disposable kind cluster and checks the provider-to-runner tunnel,
forced reconnection, hibernate/wake, warm adoption, volume persistence, and
expiry.

To regenerate code after editing the protobuf file:

```sh
pnpm proto:generate
```

For focused Kubernetes development, `scripts/kas/dev-cluster.sh` creates a
cluster that can be inspected between runs, and `scripts/kas/smoke-test.sh`
checks the controller lifecycle against it. See
[e2e-testing.md](e2e-testing.md) for both workflows.

## Running from a checkout (laptop + Docker)

Instead of the released images, a checkout installs into a dsh you run
yourself. This needs `@deepseek-ai/dsh` 0.1.1-rc.2 on your PATH. Build first,
then install the provider directory:

```sh
docker buildx bake dev --load
pnpm install && pnpm build
dsh plugin --profile web add "$PWD/provider"
```

With no `backend` configured the provider selects Docker, which is a complete
working configuration by itself. Point the manager at the locally built runner
image in your profile layer, then run `dsh web`:

```yaml
- id: sandbox-manager
  config:
    docker:
      image: dsh-runner:dev
```

On a development machine the CLI is at
`~/.dsh/profiles/web/node_modules/.bin/dsh-workbench`, and it shares the
provider's state directory (`~/.dsh-sandbox` unless `stateDir` is configured;
set `DSH_SANDBOX_STATE_DIR` to match if so).

## Releasing

Every release publishes two images together, both built for `linux/amd64` and
`linux/arm64`: `ghcr.io/zhming0/dsh-host`, the dsh distribution with the web
profile and this provider assembled, and `ghcr.io/zhming0/dsh-runner`. They
share one calendar version. The host image build stamps that version into the
provider and fails if the provider's default runner image tag would not match,
so the pair cannot drift.

The provider is not published to npm. The distribution images are the product,
and a checkout install is the contributor path.

Buildkite runs [`.buildkite/pipeline.yml`](../.buildkite/pipeline.yml) on
every branch: provider checks and tests, runner tests, a check that the
generated protobuf code is current, the Docker lifecycle smoke test, and the
Kubernetes transport and lifecycle test.

On `main`, a manual block step unlocks
[`.buildkite/pipeline.release.yml`](../.buildkite/pipeline.release.yml), which
picks a calendar version, pushes both multi-architecture images, and tags a
GitHub release.
