# Credentials and secrets

Sandboxes have no credentials of their own; they borrow the host's. The host
keeps one store of named secrets and pushes the current values to the runner
before each command, which injects them into that command's environment. The
store is global to the host — one trust domain, no per-session or
per-repository scoping.

This is the step after [installation](installations.md): the control plane and
a runner come first.

## GITHUB_TOKEN

`GITHUB_TOKEN` is the one secret most installs need. Besides being injected
like any other, it is the Git credential for github.com: the host serves it to
Git over a Unix socket, so it never lands in the workspace or in a remote URL.

Use a fine-grained personal access token scoped to the repositories sessions
work on, with **Contents: read** — add write access if the agent should push.
If you are logged in with the GitHub CLI, `gh auth token` prints a suitable
token. Without one, sessions still clone public repositories; private ones
fail at `git clone`.

## Set a secret

Secrets go in through the Web UI: **Settings → Secrets**. It is the only way
in — there is no CLI — and values are write-only: the page lists names, never
values.

A change applies before the session's next command, running sessions included:
before every command the provider re-reads the store and pushes it to the
runner. No host restart is needed.

## Credentials the host owns

Two credentials belong to the host and must never reach a sandbox:

- the **shared registration token**, in the `dsh-registration-token` Secret the
  chart creates — warm pods must hold it before any session exists, and it only
  lets a runner register a tunnel;
- a **Buildkite API token**, in a Secret you own, read into the host
  environment by `host.extraEnv` — it can create and cancel builds.

[`installations-control-plane.md`](installations-control-plane.md#credentials)
sets both up, and
[`kubernetes.md`](kubernetes.md#the-in-cluster-dsh-host) covers rotation.

## Never write values down

A value must not appear in `cordis.patch.yml`, in a values file, in a committed
file, or in chat: those are plain text, and transcripts are durable.

Sandbox code can read injected secrets — that is what they are for — so treat
everything in the store as visible to whatever a session runs. Keep each
secret as narrow as the work needs, and delete the ones you stop using.
