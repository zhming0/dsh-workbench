# End-to-end testing

Use this guide to validate the boundaries that unit tests cannot cover: the
provider talking to a real runner, lifecycle behavior in Docker and
Kubernetes, and a model driving sandbox tools through the dsh Web UI.

Run the smallest applicable layer while developing, then run every layer
affected by the change before opening a pull request.

| Layer                   | What it proves                                                                           | Required infrastructure                           |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Automated checks        | Provider, protocol, generated code, and runner behavior                                  | Node, pnpm, Go                                    |
| Docker smoke test       | Runner registration, RPC, tools, setup, hibernate/wake, persistence                      | Docker                                            |
| Kubernetes E2E test     | Real images, dial-out RPC, reconnect, warm adoption, suspend/resume, persistence, expiry | Docker, kind, kubectl                             |
| Browser acceptance test | dsh Web, workspace creation, model-to-sandbox tools, settings persistence                | Kubernetes environment, browser, model credential |

## Prerequisites

Install the repository toolchain and dependencies:

```sh
mise install
corepack enable pnpm
pnpm install --frozen-lockfile
```

The Kubernetes tests additionally need Docker, `kind`, `kubectl`, and Python 3. The scripts install the repository's pinned agent-sandbox version into a
disposable kind cluster. A full browser test needs a real model credential;
never put its value in a repository, command transcript, fixture, or manifest.

## Automated checks

Run these from the repository root:

```sh
pnpm check
pnpm format:check
pnpm test
pnpm build

(cd runner && go test -race ./... && go vet ./... && go build ./...)
```

Run them sequentially. The build produces `provider/dist`, which the Docker
smoke test imports.

When changing `proto/`, regenerate both clients and ensure the generated files
are current:

```sh
pnpm proto:generate
git diff --exit-code -- provider/src/gen runner/gen
```

## Docker lifecycle smoke test

Build the runner image and provider, then run the smoke test:

```sh
docker buildx bake dev --load
pnpm build
pnpm test:docker
```

Set `DSH_RUNNER_IMAGE` to test another local image tag:

```sh
DSH_RUNNER_IMAGE=my-runner:test pnpm test:docker
```

The test creates a temporary registration token, tunnel server, and container,
then verifies:

1. the runner registers with the provider and its health check succeeds over
   the reversed HTTP/2 tunnel;
2. secrets reach commands, and the runner's bundled tools are installed,
   including Python, Node.js, jq, yq, and the Docker client without its daemon;
3. `.dsh/setup.sh` runs exactly once;
4. hibernate/wake reconnects the runner and preserves its setup marker,
   workspace files, and mise-managed tools.

Success ends with:

```text
PASS: Docker runner registration, tools, setup, and hibernate/wake
```

The script removes its container and temporary provider state in a `finally`
block. If an interrupted run leaves a container behind, inspect it before
removing it so the failure evidence is not lost.

## Kubernetes transport and lifecycle test

Build both development images and run the self-contained test:

```sh
docker buildx bake dev host-dev --load
pnpm test:kas
```

The test creates the disposable `dsh-kas-e2e` kind cluster and installs the
pinned agent-sandbox controllers. It loads the development images and runs the
production `TunnelServer` and `KasBackend` from the host image as a Kubernetes
Job. Real warm runner pods dial that Job through the same in-cluster Service
and registration-token path used by the supported deployment.

The transport probe verifies:

1. `KasBackend` claims a real warm Sandbox;
2. its runner registers and answers an identity-checked health RPC;
3. secret injection, command streaming, and file RPCs cross the tunnel;
4. hibernate/wake recreates the runner connection and preserves workspace
   data.

It then runs the controller lifecycle smoke test, which additionally verifies
sub-second warm adoption, backing-pod identity, PVC survival across
suspend/resume, and foreground expiry of a claim, Sandbox, and PVC.

Success ends with:

```text
PASS: Kubernetes runner registration, RPC, reconnect, and hibernate/wake
PASS: agent-sandbox warm adoption, suspend/resume persistence, and expiry
PASS: Kubernetes agent-sandbox transport and lifecycle
```

The command prints Kubernetes objects, pod descriptions, and available logs on
failure, then removes the cluster. To preserve it for further investigation:

```sh
KEEP_KAS_CLUSTER=1 pnpm test:kas
```

Remove a preserved test cluster with:

```sh
scripts/kas/teardown.sh --name dsh-kas-e2e
```

Set `DSH_KAS_CLUSTER_NAME`, `DSH_RUNNER_IMAGE`, or `DSH_HOST_IMAGE` to use
non-default names or image tags.

## Browser and model acceptance test

Run this manual test for changes to dsh integration, tool routing, workspace
setup, credentials, the host image, or Web UI contributions. Create the
inspectable development cluster using the commands in
[`kubernetes.md`](kubernetes.md), rather than `pnpm test:kas`, which removes
its cluster when it finishes.

### Start a real session

1. Supply the model credential to the dsh host through the model provider's
   supported host configuration. Do not add it to Kubernetes YAML or the
   repository.
2. Forward the dsh server from the host pod:

   ```sh
   kubectl -n dsh-sandbox port-forward deploy/dsh-host 3000:3000
   ```

3. Open `http://localhost:3000`, choose the configured model, select **New
   session**, and add a disposable public repository as a Workspace.
4. Ask the model to use its shell and file tools to:
   - print `uname -a` and the working directory;
   - read a known file from the repository;
   - write a uniquely named file with known content and read it back.
5. Find the claimed Sandbox and verify the file independently in its runner
   container:

   ```sh
   kubectl -n dsh-sandbox get sandboxclaims,sandboxes,pods
   kubectl -n dsh-sandbox exec <pod> -c runner -- \
     cat /workspace/repository/<file>
   ```

The model's command hostname must be the Sandbox pod rather than the dsh host,
and the independently read file must contain the expected text. A chat answer
alone is not evidence that the tool ran in the sandbox.

If the host Deployment restarts, restart `kubectl port-forward`; it targets a
specific pod and does not follow the replacement.

### Verify UI-managed instructions

Run this scenario for changes to the Instructions page or model-context
injection:

1. Open **Settings → Instructions** and save a distinctive Global instruction.
2. Select the test Workspace and save a different workspace instruction.
3. Switch between both scopes and confirm their values remain independent.
4. Close and reopen Settings and confirm both values persisted.
5. Send a new model request and verify its behavior reflects both layers, with
   the workspace instruction taking precedence where they conflict.
6. Empty each scope and save to clean up.

The settings must persist outside the repository checkout. Confirm the test did
not create or modify an `AGENTS.md` file in the Workspace.

For UI changes, record the browser state or capture a screenshot when useful,
but also exercise the interaction and verify the resulting state. A screenshot
alone does not prove persistence or model-context injection.

## Troubleshooting

- **Docker smoke imports fail:** run `pnpm build`; the script imports
  `provider/dist`.
- **A development image does not reflect the checkout:** rebuild with
  `docker buildx bake dev host-dev --load`, then rerun `dev-cluster.sh` with
  `--load-runner-image`.
- **The warm pool never becomes ready:** inspect agent-sandbox controller
  deployments, the `dsh-universal` `SandboxWarmPool`, and runner pod events.
- **The browser stops loading after a rollout:** restart the port-forward.
- **A browser tool call fails while direct runner health succeeds:** compare
  package resolution in the host image as well as provider and runner logs;
  dsh plugins must share the host's in-box package instances.
- **Docker is unavailable:** report that the Docker, Kubernetes, and browser
  layers were not run. Unit tests do not substitute for those layers.
