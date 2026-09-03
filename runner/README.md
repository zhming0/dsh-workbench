# dsh-runner

`dsh-runner` is the in-sandbox ConnectRPC server. It dials the host rather
than accepting inbound connections: `HOST_URL` names the host's tunnel
listener (`tcp://host:port`, or `tls://host:port` to dial over TLS), and the
runner registers with `SANDBOX_ID` plus the shared secret in
`REGISTRATION_TOKEN` (or a file named by `REGISTRATION_TOKEN_FILE`). After a
registration is accepted, the runner serves its RPCs over that same
connection with HTTP/2 roles reversed, and redials with backoff whenever the
tunnel drops. RPCs are reachable only over tunnels the runner itself opened.

Secrets and Git credentials exist only in process memory. Child processes get a
small allowlisted base environment, the current secrets, and RPC-supplied
overrides; they do not inherit the runner environment. Git obtains credentials
from a mode-0600 Unix socket at `CREDENTIAL_SOCKET` (default
`/run/dsh/credentials.sock`) through `dsh-runner git-credential`.

Setup defaults to `/workspace/repository`, preserves an already initialized
workspace, and uses `.dsh-setup-done` as its durable completion marker. Keeping
the checkout beneath the persistent volume root prevents filesystem metadata
such as `lost+found` from entering the repository. The file APIs operate with
the container user's permissions; they are not a filesystem sandbox. Run the
image as its non-root `sandbox` user and isolate its filesystem/network at the
container platform boundary.

`GET /health` on `ADDR` (default `:8080`) is an unauthenticated
process-readiness probe for the kubelet; it is the only listener the runner
opens and does not expose sandbox data or RPCs.

The reference Dockerfile builds `linux/amd64` and `linux/arm64`. It includes
Git, GitHub CLI, Jujutsu, mise, ripgrep, Python with uv, Node.js,
Corepack-backed pnpm and Yarn, a native build toolchain, common archive and
process utilities, jq, yq, and the Docker CLI with Buildx and Compose. It
deliberately excludes pip, the Docker daemon, and the container runtime;
platforms that want Docker commands to reach a daemon must provide one
separately. Architecture-specific archives have pinned checksums, and the Go
stage cross-compiles from the builder's own architecture rather than running
the toolchain under emulation.

Releases are published to `ghcr.io/zhming0/dsh-runner`, tagged with the same
version as the `@zhming0/dsh-workbench` package that expects them.

When standard `OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_EXPORTER`, or
`OTEL_METRICS_EXPORTER` settings are present, the runner exports HTTP traces and
command-duration metrics. With no exporter settings, telemetry stays local and
the runner does not try to contact a collector.
