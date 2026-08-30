# dsh-runner

`dsh-runner` is the in-sandbox ConnectRPC server. It listens on `ADDR` (default
`:8080`) over h2c. Set `SANDBOX_ID` and provide an Ed25519 public key in PEM form
with `PROVIDER_PUBLIC_KEY` or `PROVIDER_PUBLIC_KEY_FILE`. Every call requires a
provider-signed EdDSA bearer JWT whose `sandbox_id` matches and whose `exp` has
not passed.

Secrets and Git credentials exist only in process memory. Child processes get a
small allowlisted base environment, the current secrets, and RPC-supplied
overrides; they do not inherit the runner environment. Git obtains credentials
from a mode-0600 Unix socket at `CREDENTIAL_SOCKET` (default
`/run/dsh/credentials.sock`) through `dsh-runner git-credential`.

Setup defaults to `/workspace`, preserves an already initialized workspace, and
uses `.dsh-setup-done` as its durable completion marker. A filesystem-created
`lost+found` directory at the root of a fresh persistent volume is preserved and
does not prevent the initial clone; other unexpected contents still do. The file
APIs operate with the container user's permissions; they are not a filesystem
sandbox. Run the image as its non-root `sandbox` user and isolate its
filesystem/network at the container platform boundary.

`GET /health` is an unauthenticated process-readiness probe. It does not expose
sandbox data. ConnectRPC health and all capability calls still require a valid
token.

The reference Dockerfile builds `linux/amd64` and `linux/arm64`. It selects the
`jj` and `mise` archives from `TARGETARCH` and verifies a pinned checksum per
architecture, so adding another one means adding both the archive name and its
checksum. The Go stage cross-compiles from the builder's own architecture rather
than running the toolchain under emulation.

Releases are published to `ghcr.io/zhming0/dsh-runner`, tagged with the same
version as the `@zhming0/dsh-workbench` package that expects them.

When standard `OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_EXPORTER`, or
`OTEL_METRICS_EXPORTER` settings are present, the runner exports HTTP traces and
command-duration metrics. With no exporter settings, telemetry stays local and
the runner does not try to contact a collector.
