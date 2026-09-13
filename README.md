# DeepSeek Harness Yawn

<br />

<p align="center">
  <strong>A DSH distribution for advanced users who love to lay back and yawn</strong><br>

</p>

<p align="center">
  <img src="docs/logo.png" alt="Project logo" style="max-width: 100%; width: 320px;" />
</p>

## Features

* Deployed as an always-on service on your LAN or the internet.
* Every session runs in its own sandbox: Kubernetes agent-sandbox, Buildkite, or Docker.
* Sandboxes hibernate when idle and wake with the same files; backends that cannot pause checkpoint instead.
* OIDC authentication through oauth2-proxy and your identity provider.
* Repository-centric workspaces: paste a URL, the session clones it.
* Credentials management in the Web UI: Secrets only reach a sandbox only when its commands run, .
* AGENTS.md editing in the Web UI.

## Rationale

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) is a great
harness, but it assumes it runs on your laptop: every session shares your
operating system, so you have to watch what the agents do, keep the machine
running, and live with the scale of one machine. All of that kept me tense.

DSH Yawn splits dsh into a control plane you deploy once and runners that host
each session's sandbox. Runners have multiple backends — Kubernetes, Buildkite,
or Docker — and can run anywhere that can reach the control plane. dsh's stock
file and command tools run inside that sandbox, never on the control plane or
your laptop, so whatever the agents do stays there. Hence the name: you can
lay back and yawn :)

## Quick start (demo)

This runs the control plane in one Docker container and starts sandboxes as
sibling containers through your Docker daemon. It is the fastest way to see a
session run, not a supported deployment — for that, read
[`docs/installations.md`](docs/installations.md).

```sh
docker run -d --name dsh-yawn \
  -p 127.0.0.1:3000:3000 -p 8081:8081 \
  -e DSH_YAWN_WEB_PORT=13000 \
  -e DSH_YAWN_CONTROL_PLANE_LAUNCH_TOKEN_ROUTE=1 \
  --group-add "$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0)" \
  -v dsh-yawn-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/zhming0/dsh-yawn-control-plane

# dsh serves its UI on loopback only, so a sidecar publishes it. This is the
# same shape as the oauth2-proxy sidecar in the Kubernetes install.
docker run -d --name dsh-yawn-ui --network container:dsh-yawn --restart unless-stopped \
  alpine/socat TCP-LISTEN:3000,fork,reuseaddr TCP4:127.0.0.1:13000

# Tell the control plane to use the Docker backend, then restart to apply.
docker exec -i dsh-yawn sh -c 'cat > /data/.dsh/profiles/web/cordis.patch.yml' <<'EOF'
- id: sandbox-manager
  config:
    profiles:
      standard:
        backend: docker
EOF
docker restart dsh-yawn
```

What the pieces do:

- The Docker socket mount lets the control plane start sibling sandbox
  containers; `--group-add` grants the socket's group (0 on Docker Desktop,
  the `docker` group on Linux).
- The sandbox profile needs only `backend: docker`: the runner image defaults
  to the tag matching the control plane, and runners dial back through
  `host.docker.internal` on the published tunnel port 8081.

Then open <http://localhost:3000/launch-token>, choose **New session**, use
**Add workspace…** with a repository URL, and send a message. The first message
needs a model credential; add one in the Web UI settings.

To clean up: `docker rm -f dsh-yawn dsh-yawn-ui`.

## FAQ

### What is `/launch-token`?

DeepSeek Harness signs each browser in with a per-process token and exchanges it for a
cookie that lasts 30 days. `/launch-token` redirects you to the tokenized URL,
so you never copy a token out of the logs. Open it through the address you use
to reach the control plane, such as
`http://localhost:3000/launch-token` or `https://dsh.example.com/launch-token`.
The route hands the token to anyone who can reach dsh's port; behind the
distribution's oauth2-proxy, that means authenticated users only.
Details: [`docs/kubernetes.md`](docs/kubernetes.md#the-in-cluster-control-plane).

### What is a sandbox's lifecycle like?

```text
new session -> start sandbox -> clone and set up repository -> run tools
                                                            |
                                                            v
follow-up <- wake with the same files <- hibernate after idle
                                               |
                                               v
                                      delete after expiry
```

The first prompt claims a sandbox, clones the repository into
`/workspace/repository`, and runs the repository's one-time `.agents/setup`
hook. After ten idle minutes the sandbox hibernates: compute stops and the
workspace survives, so the next prompt wakes it with the same files, re-running
the idempotent `.agents/resume` hook. After seven days idle it is deleted.
Archiving a session in the Web UI skips the clock: its sandbox and storage are
deleted at once, and the session can never run again.
Details: [`control-plane/README.md`](control-plane/README.md#idle-and-hibernation).

### What happens if a sandbox cannot hibernate?

A Buildkite build cannot be paused, so that backend checkpoints instead: the
working tree is committed, the commits `origin` does not have are written to a
Git bundle in the control plane's state directory, and the sandbox is
destroyed. The next prompt provisions a fresh sandbox, clones, runs
`.agents/setup`, and unpacks the bundle. Kept: the branch, its commits, and
every tracked or untracked file. Lost: ignored files, installed tools, and
which changes were staged. Docker and Kubernetes hibernate properly.
Details:
[`control-plane/README.md`](control-plane/README.md#idle-and-hibernation).

### How does the runner talk to the control plane?

It dials out. Every runner opens one WebSocket to the control plane's tunnel
listener and authenticates with the shared registration token; all RPCs then
flow control-plane → runner over that runner-initiated connection. Nothing
ever connects into a sandbox, and sandboxes accept no ingress at all. Runners
outside the cluster reach the same listener through a `/tunnel` path on the
Ingress that fronts the Web UI.
Details: [`docs/kubernetes.md`](docs/kubernetes.md#connectivity-and-isolation),
[`control-plane/README.md`](control-plane/README.md#tunnel).

### Can I still install plugins?

Yes. The control plane runs a stock dsh `web` profile on its data volume, so
`dsh plugin --profile web add <package>` works as anywhere else (on Kubernetes,
`kubectl exec` into the control-plane pod, then restart it). Three caveats:

- a package without `dsh.bundle.patch` installs as a plain dependency and
  wires up nothing;
- an image upgrade reseeds the profile's `package.json` and `node_modules`,
  dropping what you added, so re-add plugins after upgrading;
- Web sessions mount their tools through agent presets, so a bundle patch that
  renames a stock tool row changes nothing for sessions. The stock rows
  already run inside the sandbox.

## Documentation

| Page                                                                         | Covers                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`docs/installations.md`](docs/installations.md)                             | installation index: control plane, runner, credentials           |
| [`docs/installations-control-plane.md`](docs/installations-control-plane.md) | the Helm chart: install, verify, credentials, upgrade            |
| [`docs/credentials.md`](docs/credentials.md)                                 | the secret store: `GITHUB_TOKEN`, the Web UI, control-plane credentials   |
| [`docs/kubernetes.md`](docs/kubernetes.md)                                   | the Kubernetes backend: control-plane operations, isolation, smoke test   |
| [`docs/buildkite.md`](docs/buildkite.md)                                     | running sandboxes as Buildkite builds: pipeline shape and limits |
| [`control-plane/README.md`](control-plane/README.md)                         | what the bundle patch changes, every setting, secret handling    |
| [`docs/development.md`](docs/development.md)                                 | repository layout, build and test, checkout installs, releasing  |
