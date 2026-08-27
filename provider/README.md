# dsh-workbench provider

This package connects DeepSeek Harness sessions to isolated environments. It
owns the sandbox lifecycle and supplies remote filesystem, shell, and
subprocess implementations to the normal dsh tools.

The default backend uses Docker on the same machine as dsh. The Kubernetes
backend uses Kubernetes SIG agent-sandbox and must run somewhere that can reach
the in-cluster Sandbox service names.

## Install

```sh
dsh plugin --profile <name> add @zhming0/dsh-workbench
```

Each release publishes a runner image tagged with the same version as this
package, and the provider defaults to that exact tag. Pulling the image is
automatic on the first session.

To work from a checkout instead, build the runner image and this package:

```sh
docker buildx bake dev --load
pnpm install
pnpm build
```

## Use it in a dsh preset

See [`../examples/agent.cordis.yml`](../examples/agent.cordis.yml) for a small
preset. The manager, capability providers, and tools are deliberately in one
isolated Cordis group. This gives each agent the matching `sandboxManager`,
`fs`, `shell`, and `subprocess` services.

The manager accepts these settings:

| Setting          | Default              | Meaning                                             |
| ---------------- | -------------------- | --------------------------------------------------- |
| `backend`        | `docker`             | `docker` or `kas`                                   |
| `repository`     | session repository   | Repository cloned into the workspace                |
| `revision`       | repository default   | Optional branch, tag, or commit to check out        |
| `workspace`      | `/workspace`         | Absolute path inside the sandbox                    |
| `idleMs`         | 10 minutes           | Delay after a turn before hibernating               |
| `expiresAfterMs` | 7 days               | How long a hibernated workspace is retained         |
| `stateDir`       | `~/.dsh-sandbox`     | Provider keys, session records, and broker data     |
| `githubClientId` | none                 | GitHub OAuth app client ID for private repositories |
| `wipCommit`      | `false`              | Make a local safety commit before hibernating       |
| `docker.image`   | matching release tag | Runner image used by Docker                         |
| `docker.binary`  | `docker`             | Docker-compatible command                           |
| `kas.namespace`  | `dsh-sandbox`        | Namespace containing claims and warm sandboxes      |
| `kas.warmPool`   | `dsh-universal`      | Warm pool used for claims                           |
| `kas.kubeconfig` | normal client lookup | Optional kubeconfig path                            |

## Credentials and secrets

Provider state belongs on the dsh host, not in a sandbox. Files in `stateDir`
are created with owner-only permissions. The runner receives current values in
memory before it starts a command. Git credentials are served through a Unix
socket and are never written to the workspace.

Authorize GitHub before starting dsh, or let the provider put a device-code
challenge into the session:

```sh
export DSH_SANDBOX_GITHUB_CLIENT_ID=your-oauth-app-client-id
node provider/dist/cli.js auth github
```

GitHub's device flow produces a user token that can reach every repository the
user granted to the OAuth app. It is not limited to the current repository.
Use a dedicated account or wait for a future GitHub App broker when that scope
is too broad.

Set generic secrets out of band so their values never enter a chat transcript:

```sh
printf '%s' "$API_KEY" | node provider/dist/cli.js secret set API_KEY
node provider/dist/cli.js secret list
node provider/dist/cli.js secret delete API_KEY
```

The provider reloads the broker file before the next sandbox command, so CLI
changes take effect without restarting dsh. Sandbox code can read injected
secrets; the broker improves storage and cleanup, not confidentiality from the
repository being run.

## Kubernetes key setup

Kubernetes warm pods need the provider's public key before a session claims
them. Generate the key in the same `stateDir` used by dsh:

```sh
node provider/dist/cli.js key public > /tmp/dsh-provider.pub
scripts/kas/dev-cluster.sh \
  --runner-image dsh-runner:dev \
  --public-key-file /tmp/dsh-provider.pub \
  --load-runner-image
```

The private key never goes into Kubernetes.

## Milestone 1 limits

- Interactive terminals and streaming subprocess input are not implemented.
  One-shot stdin, streamed stdout/stderr, cancellation, and background process
  handles are supported.
- Shell and subprocess output is kept in bounded in-memory tails. Truncated
  output is reported, but it is not copied to a spill file.
- Docker stop/start keeps the same container. Kubernetes suspension removes
  the pod and keeps its workspace volume.
- There is no service exposure or portal support yet.
