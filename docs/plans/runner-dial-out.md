# Runner dial-out

## Problem

The provider dials the runner. That single fact constrains which backends can
exist at all: a runner must be reachable from the host, so every backend needs
an inbound path — the Docker backend publishes a loopback port, the KAS
backend requires a per-sandbox Service and FQDN (`spec.service: true` in the
template). A backend on infrastructure without inbound reachability — a
Buildkite Hosted Agent, a CI job, a machine behind NAT — is impossible today.

Reversing the connection removes that constraint. The host is the one party
that reliably has a stable address (it already serves the Web UI), so the
runner should dial the host.

## Decision

Invert the **transport** direction only. RPCs keep flowing host → runner over
the existing `RunnerService` contract; the TCP connection underneath is opened
by the runner. Decided against, in prior discussion:

- **A bidi-stream protocol.** Multiplexing concurrent RPCs (an `Exec` stream
  plus file operations) over one gRPC stream means hand-building correlation
  IDs, backpressure, and reconnect semantics — reimplementing what HTTP/2
  already provides. The 12-RPC generated surface stays.
- **frp or another tunnel sidecar.** A third-party binary in both images with
  its own config, token, and port-allocation surface, to do what ~200 lines
  per side does in our own code.
- **Keeping dial-in as a second mode.** Two connection paths through the most
  security-sensitive seam doubles the test surface and the dial-in path would
  rot. Dial-out becomes the only mode; dial-in code is deleted at the end.

## How the tunnel works

The provider listens on a dedicated tunnel port (separate from the dsh Web
UI, so oauth2-proxy never sits in front of it). The runner:

1. Dials the configured host URL (TLS when the URL says so).
2. Sends a small handshake: the registration token and its `SANDBOX_ID`.
3. On acceptance, serves its existing ConnectRPC handler over that same
   connection with roles reversed — Go's `http2.Server.ServeConn` on the
   outbound socket.

The provider keeps a registry of `sandboxId → active connection`. To talk to
a runner it builds the existing Connect transport over the registered socket
(Node `http2.connect` with a `createConnection` that returns it), so
`RunnerClient` and every call site in `provider/src/index.ts` are unchanged.
HTTP/2 multiplexes concurrent RPCs; the existing 30 s transport pings detect
dead tunnels. The runner redials with backoff whenever the tunnel drops.

The runner stops listening for RPCs entirely. Only a bare `/health` endpoint
survives for the kubelet readiness probe.

## Authentication and trust

One shared secret, `DSH_WORKBENCH_REGISTRATION_TOKEN`, replaces the keypair:

- **Runner → host:** the handshake presents the token. The env var accepts
  multiple comma-separated values on the host side so a token can be rotated
  without draining the warm pool.
- **Host → runner:** authenticity comes from the dialed URL — TLS in
  production, and the fact that the runner only serves RPCs over connections
  it opened. The per-call EdDSA JWTs, `ProviderKeyStore` signing,
  `runner/auth`, `PROVIDER_PUBLIC_KEY*`, the `dsh-runner-public-key`
  ConfigMap, and the `dsh-workbench key public` CLI command are all deleted.

This is consistent with the declared trust model (one host = one trust
domain, secrets global and pushed to every runner): a leaked token exposes no
secret an in-sandbox attacker cannot already read. It does grant one new
capability — **cross-session runner impersonation**. Sandbox A's code can read
the token and dial in claiming to be sandbox B. Mitigations, in order of
weight:

- The registry rejects a registration for a sandbox ID that already has an
  active tunnel, and logs the conflict loudly. Legitimate runners register at
  pod boot, before any untrusted code runs, so the attacker must win a race
  confined to the provision/wake window.
- The provider routes traffic and pushes secrets only for sandbox IDs it
  owns (provisioned or waking session records, or warm-pool sandboxes it
  claims).
- The existing identity check in `waitForRunner` (Health RPC must echo the
  expected `sandboxId`) stays as a sanity check over the tunnel.

Per-sandbox credentials cannot fully close this: the runner and the sandbox
share a security boundary, so anything the runner holds the sandbox can
eventually read. TOFU key pinning is a possible future hardening (noted, not
built — it reopens at wake when the pod is recreated).

Two AGENTS.md rules are deliberately amended by this plan: "the provider
always connects to the runner" becomes "RPCs always flow host → runner; the
transport is runner-initiated", and the registration token becomes the one
argued exception to "never put credentials in pod configuration".

## What changes where

**Contract (`proto/`).** `RunnerService` is untouched. The handshake is a
tiny framed exchange before HTTP/2 starts, not a proto service.

**Provider.**

- New tunnel listener + registry module owning handshake, token check,
  duplicate rejection, and socket-to-transport wiring.
- `SandboxBackend.connect()` and `RunnerAuth` leave `types.ts`: backends own
  lifecycle only; the registry owns transport. `SandboxSpec.publicKeyPem`
  is replaced by the values the backend must inject (host URL, token).
- `waitForRunner` waits on the registry (registration event or timeout)
  instead of poll-dialing.
- Docker backend: drop `--publish`, inject `HOST_URL` (host-gateway alias on
  Linux) and the token. The token is generated on first boot and persisted
  under `stateDir` (mode 0600) so existing containers survive host restarts.
- KAS backend: `serviceFqdn` disappears from the reference; wake waits for
  re-registration instead of polling the FQDN.

**Runner.**

- Replace the RPC server with dial-loop + handshake + `ServeConn`; delete the
  auth interceptor and key parsing. New env: `HOST_URL`,
  `REGISTRATION_TOKEN` (or `_FILE`). Keep `/health` on a plain listener for
  probes.

**Kubernetes manifests.**

- `20-sandbox-template.yaml`: `service: false`; drop the public-key volume,
  `PROVIDER_PUBLIC_KEY_FILE`, and the ingress NetworkPolicy rule; add egress
  to the host tunnel port; add `HOST_URL` and a `secretKeyRef` to a new
  `dsh-registration-token` Secret. `SANDBOX_ID` already comes from the
  downward API, so warm-pool pods register at boot, before any claim exists;
  the claim then binds a session to an already-connected runner.
- `10-runner-public-key.yaml` is deleted; `50-host.yaml` exposes the tunnel
  port and references the same Secret.

**User flow.** One `kubectl create secret generic dsh-registration-token
--from-literal=token=$(openssl rand -hex 32)` referenced by both host and
template — no more boot-the-host-first, extract-PEM, recreate-ConfigMap
sequence. Docker stays invisible. An external runner stack gets the same
token plus the host's public tunnel URL.

## Non-goals

- Per-sandbox runner identity (TOFU pinning) — documented residual risk.
- WebSocket or HTTP-upgrade framing for the tunnel. v1 is a raw TCP/TLS
  connection to a dedicated port; revisit only if a target environment blocks
  non-HTTP egress.
- UI for generating or rotating the token. The Secret is the source of
  truth; a view/rotate page can come later.
- Any change to session lifecycle semantics (hibernate keeps the workspace,
  wake reuses it, expiry removes it).

## Delivery slices

All four slices are implemented in this PR; the list records the build order.

1. **Tunnel core, proven on Docker.** Handshake + provider registry +
   runner dial-loop; the runner temporarily serves both paths so the tree
   stays green. Docker backend switches to the tunnel. The Node
   `http2.connect`-over-existing-socket wiring is the one mechanism with
   spike risk, so it lands first. Verified by `pnpm test:docker` plus the
   standard TypeScript and Go checks.
2. **KAS cutover.** Backend, manifests, Secret, wake-waits-for-registration.
   Verified by the `scripts/kas/` kind scripts, including a
   hibernate → wake → reconnect pass and a warm-pool claim.
3. **Delete dial-in.** Runner RPC listener, `runner/auth`, keypair and
   `key public` CLI, `PROVIDER_PUBLIC_KEY*`, per-sandbox Service, ConfigMap
   manifest, `RunnerAuth`/`publicKeyPem` plumbing.
4. **Docs.** `docs/kubernetes.md` setup and rotation runbook, both READMEs,
   the AGENTS.md boundary and credential-rule amendments, and the security
   notes above (residual impersonation risk, TLS recommendation for the
   tunnel endpoint).

## Settled decisions

- **Liveness/readiness probing.** Keep the plain `/health` listener for the
  kubelet probe. An exec probe is only worth revisiting if we ever want zero
  listeners.
- **In-cluster TLS on the tunnel port.** Ship h2c in-cluster and document
  that host authenticity then rests on the cluster network being inside the
  trust domain. Recommend TLS for any tunnel endpoint exposed beyond the
  cluster.
