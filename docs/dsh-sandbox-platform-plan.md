# dsh + Agent Sandbox Platform — Implementation Plan

## Summary

A generic sandbox execution tool for DeepSeek Harness (dsh), repo name `dsh-sandbox`: each session's execution runs in an ephemeral sandbox obtained from a pluggable *backend*. The flagship backend is Kubernetes agent-sandbox (KAS — the SIG's Sandbox / SandboxTemplate / SandboxWarmPool / SandboxClaim controllers); a minimal `docker` backend exists from early on as the dev/test substrate. This plan covers Milestone 1 only: the full sandbox lifecycle (provision → run → idle-hibernate → wake → expire). Service exposure (portals) and everything after it will be planned separately once M1 ships.

## Design decisions (locked in)

**D1 — Single universal SandboxTemplate.** All sessions claim from one warm pool backed by one image. Per-repository differences are handled by a *setup phase* inside the sandbox, not by per-repo templates.

Rationale:
- Warm pool economics: one pool means every session hits a warm sandbox. Pool-per-repo fragments capacity — long-tail repos always eat cold starts, and N pools × replica floor wastes nodes.
- One image to maintain, scan, and roll out. Template changes don't fan out.
- Cluster owns the pod spec and NetworkPolicy; repos can't escalate their own runtime privileges. Trust boundary stays server-side.

Per-repo customization moves to a repo file (`.dsh/setup.sh` or `.dsh/agent.yaml` with a `setup:` section): install toolchain versions (mise in the base image), restore dependency caches, seed env. The PVC makes repeat setup cheap — caches survive pause/resume.

Escape hatch: `.dsh/agent.yaml` may name an *allow-listed* alternate template (e.g. GPU, larger resources). Those go through the cold path or a small dedicated pool. The allow-list lives in the platform, not the repo.

**D2 — TS thin, Go heavy.** dsh plugins must be TypeScript (in-process Cordis). Keep them as dumb translation layers. All logic we want to own long-term (runner, gateway, wake proxy) is Go.

**D3 — Filesystem is the only durable state in a sandbox.** Pause = pod deleted, PVC kept. Processes and memory never survive. Everything worth keeping lives on the PVC mount or in git; wake always re-runs a declarative service/setup recipe.

**D4 — Credentials never live in the sandbox; they're fetched on demand.** The sandbox runs repo-controlled code (setup scripts, the agent's own commands), so any long-lived secret on the PVC or in pod env must be assumed exfiltratable. Instead, a credential broker in the control plane holds the durable authority and *pushes* credentials to the runner (`SetGitCredentials`, unary) right after provision and wake, refreshing before expiry once tokens are short-lived; the runner keeps them in memory only, and git's credential helper reads that in-memory store — its whole job is keeping tokens off disk. Consequences: nothing to persist across pause/resume (a resumed pod just asks again), per-session scoping is enforced at the broker (a sandbox can only get tokens for the repo its session is bound to), and revocation = broker-side only. **Accepted for v1: OAuth device-code flow** (one-time interactive grant; user token stored control-plane-side only; not per-repo scopeable — documented caveat). GitHub App installation tokens remain the upgrade path for org use. Device-flow UX: at session start, before provisioning work the user would wait on, the provider checks the broker for a token; if none exists it starts a device flow and surfaces the challenge in the session ("visit github.com/login/device, enter ABCD-1234" — the code is single-use and non-secret, so chat transit is fine, unlike D5 values), polls GitHub in the background, and proceeds on grant. The runner is not involved in auth acquisition at all. A `dsh-sandbox auth github` CLI command offers the same flow eagerly at setup, sharing the broker code path. v1 uses classic non-expiring OAuth tokens; refresh-token rotation (GitHub expiring tokens) is a later opt-in.

**D5 — Generic secrets (API keys etc.) are injected into process env by the runner at exec time, never into the pod spec.** Two reasons the obvious "envFrom a shared k8s Secret in the SandboxTemplate" doesn't work: warm-pool pods are created *before* any session claims them, so template-level env is frozen at pod creation (updates don't propagate, and per-session values are impossible); and pod-spec env is visible to anything in the pod for its whole life. Instead the provider pushes secrets to the runner (`SetSecrets`, unary) at session bind and again on change (and on every wake), and the runner merges them into the environment of every process it spawns (setup script, bash tool, services). Same store-once-use-everywhere behavior as a shared Secret, but values update without pod restarts and survive pause/resume for free. Honest caveat: unlike git tokens, these secrets are necessarily *usable* by sandbox code (that's their purpose), so a malicious setup script can read them — the broker buys lifecycle hygiene here, not confidentiality. Accepted for v1 per priority on working > least-privilege. Configuration is out-of-band for values (CLI/kubectl into the control-plane store — secret values must never pass through chat, since session transcripts are durable); a UI can list names/metadata later. Cheap future scoping: repos declare needed secret *names* in `.dsh/agent.yaml`, broker grants only those.

**D6 — Provider↔runner transport is ConnectRPC.** Schema-first: one protobuf package in the monorepo (`proto/`), codegen via buf — connect-go for the runner server, connect-es for the provider client. Wire choices: the Connect protocol (not gRPC-over-the-wire), so plain HTTP tooling and curl work for debugging; h2c from day one, because `Exec` is a server-streaming call (stdout/stderr chunks + exit code as a message stream) and eventual PTY support means bidi streaming, which requires HTTP/2 — this is all in-cluster with no middleboxes, so the usual HTTP/2 trailer/proxy pain doesn't apply. Enable HTTP/2 keepalive pings on the provider's client so quiet stretches in long-running execs aren't mistaken for dead connections. Auth: asymmetric, because warm pools make per-sandbox shared secrets impossible to inject (pods exist before claims). The provider holds a keypair generated at install; the *public* key — non-secret, so safe to share across all pods — ships in the base image / template env. A client interceptor attaches a short-lived signed token (JWT: `sandbox_id` + few-minute expiry, provider-signed) to every call; the runner verifies signature against the baked-in public key, expiry, and that `sandbox_id` matches its own identity (downward-API pod name on KAS, env var on docker) — the identity check prevents cross-sandbox replay. Endpoint authenticity in the other direction inherits from the backend (endpoints come from the Kubernetes/Docker API, an authenticated channel). Confidentiality tiers: docker is localhost; KAS is cleartext in-cluster inside default-deny NetworkPolicy (standard posture, mTLS upgradeable later); remote backends must return TLS endpoints as part of their D7 contract. **Connection direction: provider-initiated, always — and no bidi streaming in M1.** The runner never dials out to the provider, and never *asks* it anything: a sandbox may be unable to reach the dsh host at all (laptop provider + in-cluster pods today; remote sandbox backends later). Everything the runner needs is pushed to it via unary calls the provider makes as client — `SetSecrets` and `SetGitCredentials` after provision and on every wake/change (D4/D5) — so the M1 schema is unary calls plus a single server-streaming `Exec`. No long-lived stream means no stream lifecycle to manage: no reconnect logic, no half-dead detection, no in-flight replay; every call is independent, which also makes wake trivial (re-push, done). Future runner→provider notifications (e.g. service status for portals) become a server-streaming `WatchEvents` the provider subscribes to — still not bidi; genuine bidi is only ever needed for interactive PTY, which is deferred. h2c stays as a preference rather than a requirement: free in-cluster, multiplexes concurrent execs over one connection per sandbox, and keeps the PTY door open. Net effect: the system's only network requirement is "provider can reach the runner endpoint," and guaranteeing that is each D7 backend's job (docker: published local port; KAS: sandbox router or in-cluster route; future remote backends: public endpoint or tunnel). To keep a future dial-out topology cheap (hosted provider, runners in egress-only/air-gapped networks dialing out, buildkite-agent-style), the provider abstracts "obtain a connection to sandbox X" behind a small interface rather than assuming a dialable URL — an agent-style backend can later satisfy it with a runner-initiated reverse tunnel (which reintroduces long-lived-stream machinery, so it's deliberately deferred, not precluded). Sandboxes keep default-deny ingress except the provider, and egress policy needs no control-plane carve-out — sandbox code has no route to the broker at all.

**D7 — Sandbox acquisition is a pluggable backend; KAS is the first real one, `docker` is the test substrate.** Everything above the backend is already provider-agnostic: capabilities, runner, broker, and RPC know nothing about Kubernetes. The backend's whole job is "get me a runner and manage its life":

```
provision(session, spec) → { endpoint, sandboxId, workspaceRef }
hibernate(ref) / wake(ref)      # optional capability
destroy(ref)
expireAt(ref, deadline)
health(ref)
```

Rules that keep the abstraction honest: the interface expresses *intents* (hibernate-keeping-workspace, expire-at) never mechanisms (spec.paused, PVC, shutdownTime — those live in `backends/kas/` only); backends declare capabilities (`supportsHibernate`) and the core's idle logic degrades gracefully (no hibernate → expire, next follow-up cold-paths), which D3's weakest-common-denominator model already assumes. The `docker` backend (docker run/stop/start of the same base image, runner endpoint on a published port) is deliberately trivial and exists so the provider, runner, RPC, credential helper, and secret injection are all developable and CI-testable with no cluster — and so the published plugin works on a laptop out of the box. docker stop/start preserves the container filesystem, so it exercises the hibernate/wake path too. No third backend gets built until a real need arrives; the interface earns generality from the second implementation, not speculation.

## Components

One monorepo (`dsh-sandbox`), one folder per runnable component. Exactly two runnable components — lifecycle management (idle timers, hibernate/wake, expiry) and the credential/secret broker both live *inside* the sandbox-provider, not as separate services. Backends are folders inside the provider, implementing the D7 interface.

| Component | Folder | Language | Runs where | Role |
|---|---|---|---|---|
| `sandbox-provider` (dsh plugin) | `provider/` (backends in `provider/backends/kas/`, `provider/backends/docker/`) | TS | dsh process | Implements fs/shell/subprocess capabilities per session by RPC to the runner; session-start/idle/wake hooks; owns lifecycle intents and the credential + secret broker (D4/D5); delegates provision/hibernate/wake/destroy to the configured backend (D7) |
| `runner` | `runner/` | Go | inside each sandbox (pod or container) | Serves exec/file/stream RPC (ConnectRPC); git credential helper; secret env injection; runs setup phase; supervises services (future). Backend-agnostic by design |

Shared in the repo besides the two components: the RPC schema (`proto/`, protobuf + buf codegen, single source of truth for both sides — see D6), the base image Dockerfile (mise-managed toolchains, git, jj, runner binary, non-root user), and the Phase 1.1 reference manifests + smoke test.

## Milestone 1 — Sandbox lifecycle

Goal: a dsh session transparently gets its own sandbox; built-in tools (bash, read, edit) execute there; idle sessions hibernate to storage-only cost; follow-ups resume seamlessly; abandoned sandboxes expire.

### Phase 1.1 — Prerequisites & reference environment
The cluster itself is the *operator's* responsibility, not a project deliverable: whoever runs the plugin brings a cluster with the agent-sandbox controller installed and templates authored to their policy. Our work is the reference material and the validation of the flow we depend on:
- Reference manifests (documented, copy-paste-able): a universal SandboxTemplate example (pod spec, RuntimeClass notes — runc vs. gVisor, NetworkPolicy with default-deny ingress and egress allow-list, volumeClaimTemplate), a SandboxWarmPool example, RBAC for whatever creates SandboxClaims.
- A compatibility statement: pinned agent-sandbox release range the plugin is tested against (it's pre-1.0 and moving).
- A smoke-test script the operator (and our CI) can run against any cluster: claim → adopted in <1s; `spec.paused` toggling → PVC survives, pod cycles; `shutdownTime` deletion fires; report resume latency.
- A disposable dev/test cluster recipe using exactly those reference manifests — kind or k3d, scriptable, so the full KAS flow can be stood up (and torn down) by CI or by an agent working on the implementation, with no pre-existing infrastructure assumed.
- Exit criteria: smoke test passes on the dev cluster; a stranger could stand up prerequisites from the docs alone.

### Phase 1.2 — Runner
- Go binary baked into the base image; listens on one port.
- RPC surface (ConnectRPC): `Exec` (cmd, env, cwd, streamed stdout/stderr chunks, exit code), `ReadFile`, `WriteFile`, `Stat/List`, `Health`. PTY support can wait.
- Auth: verify provider-signed short-lived tokens against the baked-in public key, plus own-identity check (D6). No per-sandbox secret distribution.
- Git credential helper: runner registers itself as the in-sandbox `git credential` helper; on demand it fetches a short-lived token from the control-plane broker over its RPC channel (D4). No credential material on the PVC, ever.
- Setup phase: on first connect, if `/workspace/repository/.dsh-setup-done` absent, clone repo there (auth via the credential helper), run `.dsh/setup.sh`, mark done. Idempotent — reruns after PVC-preserving resume are cheap no-ops.
- Exit criteria: from a laptop, `grpcurl`-drive a warm sandbox through clone + build of a real repo.

### Phase 1.3 — dsh provider plugin (TS)
- Implement the fs / shell / subprocess capability interfaces against the runner RPC. No changes to built-in tools — they follow the registered implementations.
- Build the D7 backend interface with the `docker` backend first: the whole provider is developable and CI-testable on a laptop before touching a cluster. The KAS backend then implements the same interface (SandboxClaim on provision, `spec.paused` on hibernate/wake, `shutdownTime` on expireAt).
- Per-session wiring: on session start, resolve workspace → backend.provision → wait ready → register providers scoped to that session (isolated realm, per the preset mechanism).
- Session record stores the backend's workspaceRef + runner endpoint/sandboxId for later wake.
- Exit criteria: a dsh web UI session runs `bash("ls")`, edits files, and everything lands in the sandbox; two concurrent sessions land in different sandboxes; the same test suite passes against both backends.

### Phase 1.4 — Idle / pause / resume / expire
- Idle: turn-end event starts a timer (default 10 min, per-repo overridable). Fire → optional WIP safety net (commit to a `wip/` ref or `jj` op push) → patch `paused: true`, set `shutdownTime: now+7d`.
- Resume: follow-up to a paused session → patch `paused: false` → wait ready → re-register providers → runner re-runs setup phase (no-op) → continue turn. Target: user-visible delay in single-digit seconds.
- Expire: past `shutdownTime`, sandbox + PVC gone. Next follow-up falls back to cold path: fresh claim, full setup. Conversation state is untouched (dsh sessions are durable independently).
- Crash handling: provider health-checks the runner; on pod loss mid-turn, surface a clear tool error and offer resume rather than hanging.
- Exit criteria: leave a session 15 min → pod gone, PVC present → send a message → session continues with prior files intact.

### Phase 1.5 — M1 hardening
- Observability: provider and runner emit standard OTel traces/metrics (claim latency, resume latency, lifecycle transitions, exec durations) to whatever collector the operator points them at.
- Warm pool sizing vs. real usage; verify eviction annotations don't fight the idle logic.
- Failure drills: node drain with hibernated sandboxes, PVC attach/mount contention, controller restart mid-claim.

## Future work (explicitly out of scope for this plan)

To be planned separately after M1 ships, in rough order:
- **Portals / service exposure**: `.dsh/services.yaml` convention + runner supervisor, wildcard-DNS ingress to sandbox ports, signed session-scoped access, wake-on-request. The runner's exec/RPC design in M1 should not preclude a supervisor later, but no portal code is written now.
- **Gateway**: Go service speaking the dsh SDK JSON-RPC protocol (Discord first). Out-of-process clients can drive sessions fully; capability replacement stays in the M1 provider.
- **Agent-style (dial-out) backend**: for a hosted provider with runners in NAT'd/egress-only/air-gapped networks — runner registers outbound with a backend-issued registration token; provider RPCs multiplex over the reverse tunnel. Same RPC schema; different transport establishment.
- **Cross-sandbox subagents**: children as remote dsh processes in their own sandboxes; parent-relayed messaging first.

## Risks & open questions

- dsh is a developer preview with explicit breaking-change warnings; agent-sandbox is pre-1.0. Pin both; budget for plugin churn on upgrades.
- Credentials are designed (D4), but two residuals: device-flow user tokens can't be repo-scoped, so personal-repo users implicitly trust every sandbox they start with their whole-account token — document this loudly; and non-GitHub forges need their own broker backend eventually.
- One PVC per session vs. reuse per repo+user: start per-session (simple GC story); revisit if PVC provisioning latency or storage cost bites.
- `.dsh/setup.sh` is repo-controlled code running in the sandbox — acceptable by design (that's what the sandbox is for), but egress policy must assume it's hostile.
- Multi-user: dsh has no user model. Current stance: one dsh instance per user; the gateway (M3) is where identity lives. Don't accidentally build multi-tenancy into M1.
