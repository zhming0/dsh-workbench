# Sandbox lifecycle hardening

## Problem

The hibernate → expire lifecycle runs inside the dsh host process. When that
process dies while a sandbox is in the `running` state — a crash, a closed
laptop, a rolling update of a future in-cluster host — nothing cleans up:

- **KAS**: the Sandbox keeps running with no `shutdownTime`, because
  `expireAt` is only called at hibernate time and during boot reconcile of
  already-hibernated records. A running-state orphan burns cluster resources
  until a host with the same `stateDir` boots again.
- **Docker**: the container keeps running. Same-machine, so the next dsh boot
  reconciles it, but until then it runs unbounded.

A second, smaller gap: a *clean* host shutdown behaves no better than a crash.
The manager's disposal hook only clears timers, so stopping dsh leaves running
sandboxes running instead of parking them.

Two fixes, in dependency order. Fix 1 is the safety net (correctness under
host death); fix 2 is the clean path (prompt parking on graceful shutdown).
With fix 1 in place, fix 2 is hygiene rather than correctness.

## Fix 1 — running-state backstop deadline

Every sandbox carries a backend-side deadline from the moment it exists, not
only after hibernate.

**Deadline semantics.** The backstop must never delete a workspace sooner than
the normal lifecycle would. The normal path retains data until roughly
`last activity + idleMs + expiresAfterMs`, so the backstop deadline is exactly
that: `now + idleMs + expiresAfterMs`, derived from existing settings. No new
setting.

**Where the calls go** (all in the manager, `provider/src/index.ts`; the
backend interface is unchanged — `expireAt` is already the intent per D7):

- after `backend.provision(...)` succeeds,
- after `backend.wake(...)` succeeds — required, not optional, because the KAS
  backend's `wake` clears the claim's expiry before unpausing
  (`clearExpiry` in `provider/src/backends/kas.ts`),
- at `turn/end`, alongside `scheduleIdle`, to refresh the deadline as the
  session stays active,
- in boot reconcile (`initialize`), for `running` records, which today only
  get an idle timer re-armed.

**Record shape.** Persist `expiresAt` on `running` records too. The existing
follow-up check in `ensureRunningUnlocked` (destroy the record when
`expiresAt` has passed) then covers running-state orphans uniformly, and boot
reconcile can re-arm the exact deadline instead of recomputing it.

**Backend asymmetry, accepted.** Docker's `expireAt` is an in-process timer,
so the backstop only protects while the host lives; boot reconcile remains the
recovery path there. That is fine — Docker orphans are on the user's own
machine. KAS gets the real benefit: `shutdownTime` is enforced by the cluster
with no host involvement. The manager stays backend-agnostic and does not
special-case this.

**Refresh cost.** One `expireAt` per turn end. On KAS that is one JSON patch
to the SandboxClaim per turn, negligible at personal-use volume. Add
throttling only if it ever shows up in practice.

## Fix 2 — park running sandboxes on host shutdown

On graceful shutdown, hibernate every `running` session through the existing
`hibernate` path (so `wipCommit` and expiry-setting behavior stay identical),
in parallel across sessions, serialized per session as today.

**Open question — where the shutdown hook lives.** The manager's `ctx.effect`
cleanup is currently synchronous timer-clearing. Before implementing, verify
against `@deepseek-ai/cordis` 's built source whether an async disposal
returned from `ctx.effect` is awaited during plugin teardown, and whether the
dsh launcher runs plugin teardown on SIGTERM/SIGINT at all. Default plan:

- if Cordis awaits async disposal and the launcher triggers it on SIGTERM,
  use `ctx.effect` — no process-level hooks;
- otherwise, register a SIGTERM/SIGINT handler in the manager that runs the
  parking pass and then lets the process exit. A plugin owning process signals
  is intrusive, so this is the fallback, not the default.

**Time budget.** Docker hibernate is `docker stop --time 10` per sandbox and
KAS suspend waits for the `Suspended` condition, so parking many sessions must
run concurrently to fit a typical 30-second termination grace period. If the
budget is exceeded, fix 1's backstop still bounds the damage.

## Non-goals

- Headless-surface support. The supported surface is `web`; documenting that
  is part of the distribution work, tracked separately.
- Docker-side cleanup that survives host death (e.g. label-based pruning).
  Boot reconcile is sufficient on a single machine.
- Any change to the proto contract, the runner, or the backend interface.

## Delivery slices

1. **Backstop deadline** — manager changes (provision, wake, turn-end refresh,
   boot reconcile, `expiresAt` on running records) plus unit tests in
   `provider/tests/core.test.ts` asserting `expireAt` is called with
   `now + idleMs + expiresAfterMs` at each of the four points, using the fake
   backend. Verify with `pnpm check && pnpm test && pnpm build`.
2. **Shutdown parking** — resolve the Cordis disposal question, then implement
   the parking pass with a unit test that disposes the plugin scope and
   asserts running sessions were hibernated. Run `pnpm test:docker` since this
   touches the Docker lifecycle path.
3. **Cluster validation** — extend `scripts/kas/smoke-test.sh` to assert a
   freshly provisioned claim carries `spec.lifecycle.shutdownTime`, and
   re-run the kind lifecycle suite.

Update the lifecycle description in `README.md` and `provider/README.md`
(idle/expiry semantics now include the running-state backstop) as part of
slice 1.
