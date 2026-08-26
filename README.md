# dsh-sandbox

`dsh-sandbox` gives each DeepSeek Harness session its own working environment.
Normal dsh file and command tools use that environment without needing special
tool versions.

Milestone 1 implements the complete workspace lifecycle:

```text
new session -> start sandbox -> clone and set up repository -> run tools
                                                            |
                                                            v
follow-up <- wake with the same files <- hibernate after idle
                                               |
                                               v
                                      delete after expiry
```

The project supports two ways to run a sandbox:

- **Docker** is the local development and test path. Hibernation stops a
  container and waking starts the same container.
- **Kubernetes agent-sandbox** is the cluster path. It claims a warm Sandbox,
  removes the pod while idle, and keeps the workspace volume until expiry.

The Kubernetes integration is pinned to agent-sandbox **v0.5.4** and its
`v1beta1` APIs. Both agent-sandbox and dsh are pre-release dependencies, so the
versions in this repository are intentional.

## Repository layout

| Path | Purpose |
| --- | --- |
| `provider/` | TypeScript dsh plugin, lifecycle policy, backends, and credential broker |
| `runner/` | Go server that runs inside each sandbox |
| `proto/` | Single ConnectRPC contract used by provider and runner |
| `deploy/kubernetes/` | Reference warm pool, template, network policy, and RBAC |
| `scripts/kas/` | Disposable kind cluster and lifecycle smoke test |
| `examples/` | dsh preset using the sandbox-backed tools |

The provider always starts connections. The runner never needs a route back to
the dsh host. Short-lived signed tokens protect every runner call and include
the expected sandbox identity.

## Build and test

Required tools are Node.js 24 or 22.19+, pnpm 11.7, Go 1.26.7, and Buf. Docker
is needed for the end-to-end local test. The reference runner image currently
targets Linux amd64 because its pinned `jj` and `mise` downloads are amd64
builds.

```sh
pnpm install
pnpm check
pnpm test
pnpm build

(cd runner && go test -race ./... && go vet ./... && go build ./cmd/dsh-runner)
docker build -t dsh-runner:dev runner
pnpm test:docker
```

The Docker smoke test checks signed access, secret injection, Git/Jujutsu/mise,
first-run setup, and file survival across stop/start.

To regenerate code after editing the protobuf file:

```sh
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.10
go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.19.1
pnpm proto:generate
```

To test the Kubernetes lifecycle locally, the scripts in `scripts/kas/` create
a disposable kind cluster and check warm claim, suspend, resume, volume
persistence, and expiry.

## Try it with dsh

Build the provider and runner, then use
[`examples/agent.cordis.yml`](examples/agent.cordis.yml) in a dsh installation
that has this workspace package linked. The example keeps the lifecycle
manager, filesystem, shell, subprocess, and their model-facing tools in one
isolated group.

Provider configuration and credential commands are documented in
[`provider/README.md`](provider/README.md).

Repositories may include an executable `.dsh/setup.sh`. The runner calls it
once after cloning. The completion marker and mise tool cache live on the
workspace volume, so a Kubernetes wake does not repeat successful setup work.

## Kubernetes reference environment

The short path is:

```sh
node provider/dist/cli.js key public > /tmp/dsh-provider.pub
scripts/kas/dev-cluster.sh \
  --runner-image dsh-runner:dev \
  --public-key-file /tmp/dsh-provider.pub \
  --load-runner-image
scripts/kas/smoke-test.sh
scripts/kas/teardown.sh
```

See [`docs/kubernetes.md`](docs/kubernetes.md) before using the manifests in a
real cluster. The example uses normal container isolation so it works in kind;
hostile workloads need a stronger runtime such as gVisor and a network policy
suited to the cluster.

## Credentials, secrets, and trust

- The provider's signing key, GitHub token, and configured secrets stay in an
  owner-only directory on the dsh host.
- A runner keeps pushed credentials in memory. Its Git helper reads them from
  a private Unix socket, not from the workspace.
- Secret values are added only to child-process environments. Repository code
  can read them by design, so only run repositories trusted with those values.
- The accepted GitHub device-flow token is user-wide, not repository-scoped.
  This is suitable for one dsh user per provider instance, not shared hosting.

## Observability

The provider records OpenTelemetry claim time, resume time, lifecycle changes,
and command time through the dsh host's OpenTelemetry setup. The runner exports
HTTP traces and command-duration metrics when standard `OTEL_*` exporter or
collector environment variables are present. With no telemetry configuration,
it does not try to contact a local collector.

## Milestone 1 boundaries

This release does not include interactive terminals, live streaming stdin,
service supervision, public service URLs, or cross-sandbox child agents. It
does support one-shot stdin, streamed output, command cancellation, bounded
background output, automatic idle hibernation, wake, and final cleanup.
