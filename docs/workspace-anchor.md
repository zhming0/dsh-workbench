# Repository-backed dsh Workspaces

## Status

Implemented. In the Web UI, **Add workspace…** now opens a repository URL
dialog. The provider creates a host anchor, registers it as a dsh Workspace,
and later clones that repository into the session's sandbox.

## Why an anchor is necessary

`@deepseek-ai/dsh-workspace` defines a Workspace as a real directory on the dsh
host:

- `create(path)` resolves the path with `fs.realpath` and rejects a missing or
  non-directory path.
- `Workspace.attachSession(id)` accepts only a session whose immutable
  `SessionHeader.cwd` resolves to exactly that Workspace path.
- Web session creation chooses `cwd` from the selected Workspace before it
  creates the Agent and Session.

The actual checkout cannot satisfy that contract because it lives at
`/workspace` inside a container or Kubernetes Sandbox. A small, durable host
directory can. It is identity for dsh; model-facing filesystem and command
operations still resolve inside the sandbox.

## Flow

```text
repository URL
  → normalize and validate
  → create ~/.dsh-sandbox/workspace-anchors/<slug>-<hash>/
  → persist owner-only repository metadata
  → register the anchor as a dsh Workspace named owner/repo
  → dsh creates a session with cwd = anchor
  → provider resolves the anchor metadata
  → runner clones that repository into /workspace
```

The browser plugin occupies the two directory-flow slots declared by
`@deepseek-ai/dsh-client-ui-workspace`. It reports the registered anchor path
through the stock `onPicked(path)` contract, so dsh continues to own Workspace
selection, blank-session reuse, and session attachment. No session metadata is
rewritten after creation.

The browser invokes host creation through one Typert Remote method. The method
uses the Web API's existing trusted-host boundary; no separate HTTP route or
browser trust policy is introduced. The provider reports a `repository`
directory-picker capability to the host API; dsh's documented unknown-kind
behavior keeps the stock host-folder RPCs unavailable without loading their
competing browser flow.

## Identity and storage

Repository URLs are normalized before hashing. GitHub SCP and SSH forms become
HTTPS, a trailing `.git` is removed, and host names are canonicalized. URLs
containing HTTP credentials, queries, fragments, unsupported protocols, or no
repository path are rejected. This keeps credentials out of durable metadata.

Each anchor contains only `repository.json`; repository files are never written
there. Directories use mode `0700` and metadata uses `0600`. The readable slug
is diagnostic only; a SHA-256 prefix provides identity without permitting URL
path traversal.

Anchors are kept when a sandbox expires. Deleting one would make historical dsh
Workspace membership report a missing directory, while its storage cost is one
small metadata file.

## Profile behavior

The repository dialog is a Web-only client surface. Headless has no Workspace
registry, makes no anchor, and keeps its existing repository resolution:
configured `repository`, then `git remote get-url origin` in the session cwd.

For Web sessions created from a managed anchor, its repository metadata takes
precedence over the fallback `repository` setting. Existing sessions from real
host checkouts retain the old fallback and auto-detection behavior.

## Exit criteria

- A repository URL creates a correctly titled dsh Workspace.
- Starting a session in it gives the immutable Session header the anchor cwd.
- The provider maps that cwd back to the repository URL and provisions the
  sandbox checkout at `/workspace`.
- Equivalent GitHub URL forms reuse one anchor; different repositories do not.
- Concurrent creation is idempotent and leaves complete owner-only metadata.
- Headless creates no anchor and requires no Workspace service.
