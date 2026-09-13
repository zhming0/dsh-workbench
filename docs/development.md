# Development

How to build and test dsh-yawn, run it from a checkout, and cut a
release. For what the project is and how to deploy it, start with the
[README](../README.md).

## Repository layout

| Path                 | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `control-plane/`          | TypeScript dsh plugin, bundle patch, lifecycle policy, backends, credential broker |
| `runner/`            | Go server that runs inside each sandbox                                            |
| `proto/`             | Single ConnectRPC contract used by the control plane and the runner                             |
| `deploy/helm/`       | Helm chart for the control plane (control plane, tunnel, token, RBAC)          |
| `deploy/kubernetes/` | Kustomize base for the Kubernetes sandbox pool (template, warm pool)             |
| `scripts/kas/`       | Disposable kind cluster and lifecycle smoke test                                   |
| `examples/`          | Agent preset for the per-session route                                             |

## Build and test

[`mise.toml`](../mise.toml) pins Node, Go, the protobuf plugins, and the
linter binaries. CI installs from the same file, so a build and a laptop agree
by construction. Install [mise](https://mise.jdx.dev), then:

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
pnpm lint
pnpm test
pnpm build

(cd runner && go test -race ./... && go build ./cmd/dsh-yawn-runner)
docker buildx bake dev --load
pnpm test:docker
docker buildx bake dev control-plane-dev --load
pnpm test:kas
```

`docker buildx bake dev` builds the runner image for the current machine; the
release build covers `linux/amd64` and `linux/arm64`. The Docker smoke test
checks runner registration, secret injection, the bundled command-line tools,
first-run setup, and file survival across stop/start. The Kubernetes test
creates a disposable kind cluster and checks the control plane-to-runner tunnel,
forced reconnection, hibernate/wake, warm adoption, volume persistence, and
expiry.

`pnpm lint` lints both sides: ESLint with type-aware rules for the control plane
([`control-plane/eslint.config.mjs`](../control-plane/eslint.config.mjs)) and
golangci-lint for the runner ([`runner/.golangci.yml`](../runner/.golangci.yml),
which includes gofmt). Both restrict themselves to rules that catch real
defects — unchecked errors and promises, dead code, suspicious constructs —
and leave expression style to prettier and gofmt.

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
yourself. This needs `@deepseek-ai/dsh` 0.1.5-rc.2 on your PATH. Build first,
then install the control plane directory:

```sh
docker buildx bake dev --load
pnpm install && pnpm build
dsh plugin --profile web add "$PWD/control-plane"
```

Declare one Docker profile that points at the locally built runner image in
your profile layer, then run `dsh web` and open the `?token=` URL it prints:

```yaml
- id: sandbox-manager
  config:
    profiles:
      standard:
        backend: docker
        image: dsh-yawn-runner:dev
```

To exercise the profile chip without a cluster, declare two Docker profiles
with the same image; only the name differs, which is enough to see the choice
land on the session record:

```yaml
- id: sandbox-manager
  config:
    profiles:
      standard: { backend: docker, image: dsh-yawn-runner:dev }
      large: { backend: docker, image: dsh-yawn-runner:dev }
```

## Releasing

Every release publishes two images together, both built for `linux/amd64` and
`linux/arm64`: `ghcr.io/zhming0/dsh-yawn-control-plane`, the dsh distribution with the web
profile and this control plane assembled, and `ghcr.io/zhming0/dsh-yawn-runner`. They
share one calendar version. The control-plane image build stamps that version into the
provider and fails if the control plane's default runner image tag would not match,
so the pair cannot drift.

The control plane is not published to npm. The distribution images are the product,
and a checkout install is the contributor path.

Buildkite runs [`.buildkite/pipeline.yml`](../.buildkite/pipeline.yml) on
every branch: control-plane checks and tests, runner tests, a check that the
generated protobuf code is current, the Docker lifecycle smoke test, and the
Kubernetes transport and lifecycle test.

On `main`, a manual block step unlocks
[`.buildkite/pipeline.release.yml`](../.buildkite/pipeline.release.yml), which
picks a calendar version, pushes both multi-architecture images, stamps that
version into the chart's `appVersion`, and publishes the chart to
`ghcr.io/zhming0/charts`. A release commits nothing: `main` is protected by a
ruleset that requires a pull request and the `buildkite/dsh-yawn` check, so the
stamp stays in the build checkout and the published chart carries it. The
checked-in `version` and `appVersion` can therefore lag the published chart.

The GitHub release tags the commit the build started from, so `?ref=<version>`
in the pool base names a ref whose manifests are that release's. The base names
the runner image without a tag; an operator's overlay pins it to the version
they installed, and the chart's `appVersion` is the one to match.
