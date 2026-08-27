# Task: anchor sessions in the dsh workspace registry

## Problem

dsh's Web UI groups sessions by workspace. A session that this plugin runs is
never grouped, so it appears under Ungrouped in the sidebar forever. Nothing is
broken, but the product surface looks broken.

The cause is in `@deepseek-ai/dsh-workspace`, which owns `ctx.workspaceRegistry`:

- `create(path)` canonicalizes through `fs.realpath` and rejects a path that
  does not exist or is not a directory.
- `Workspace.attachSession(id)` accepts a session only when its header `cwd`
  canonicalizes to exactly the workspace path.
- `status()` stats the host filesystem and returns `'ok' | 'missing-dir'`.

Every check runs on the **dsh host**. Our workspace is `/workspace` inside a
container, which does not exist on the host, so `create` rejects with `ENOENT`
and no session of ours can ever attach.

Two facts make this fixable without touching dsh:

- `SessionHeader.cwd` is optional and is only ever compared, never used to
  reach the filesystem by the registry itself.
- The registry is pure bookkeeping. Its own README states, under Model
  Experience: "What the model sees: Nothing." It registers no tools, injects no
  prompts, and writes no session events.

## Chosen approach: a host anchor directory

Give every repository a real but empty directory on the dsh host and register
that as the workspace. The container stays where work happens; the anchor exists
only to be a stable identity the registry will accept.

```text
~/.dsh-workbench/anchors/github.com/<owner>/<repo>/     (empty, mode 0700)
```

- Create the anchor before calling `workspaceRegistry.create(path, title)`.
- Pass `title` as `<owner>/<repo>` so the sidebar reads correctly rather than
  showing a basename.
- Create sessions with `meta.cwd` set to the anchor path, so `attachSession`
  passes the realpath comparison unmodified.
- Never write repository content into the anchor. `fs`, `shell`, and
  `subprocess` are already replaced by this plugin, so nothing reads it.

### Why not the alternatives

**Replace `workspaceRegistry`.** The `- id: workspace` row lives in the
`@deepseek-ai/dsh-web-app` bundle patch, not in `dsh-base`, so a later bundle
can disable it and provide its own. `Workspace.path` is typed as plain `string`,
so once we own the implementation a repository URL is legal.

Rejected for now on cost and churn. It means reimplementing durable ordering,
session accounting, the archive set, `insertBefore` semantics, and the startup
bootstrap that groups historical sessions from `sessionPersistence.list()`,
while preserving the `workspace.*` wire shape (`workspaceId`, `path`, `title`,
`sessionIds`, `createdAt`, `updatedAt`) that `@deepseek-ai/dsh-host-apiproxy`
and the client picker depend on. That is a package-private interface at
`0.1.1-rc.2` with no stability promise, so it would need resyncing every rc.

**Change dsh upstream.** The realpath canon is the only blocker to
repository-anchored workspaces, and dsh will need this for any remote or
cloud-backed session. Worth raising as an issue in parallel, but we should not
block on someone else's roadmap.

## Work

1. Anchor path resolution: derive a stable, filesystem-safe anchor path from a
   normalized repository URL. Reuse `normalizeRepositoryUrl` from
   `provider/src/broker.ts` so anchor identity and credential scoping agree on
   what one repository is.
2. Anchor creation: create the directory with owner-only permissions under the
   provider's state directory. Idempotent, and it must not race between two
   sessions starting on the same repository at once.
3. Registration: on session start, resolve or create the workspace through
   `ctx.workspaceRegistry`, then attach the session. `workspaceRegistry` is only
   mounted by the Web app bundle, so inject it optionally with `ctx.get` and
   skip the whole path when it is absent. Headless must keep working untouched.
4. Titles: set `<owner>/<repo>` at create time. Do not rewrite a title the user
   has since renamed.
5. Cleanup: decide what happens to an anchor when a sandbox expires. Leaning
   toward keeping it, because deleting the workspace registration would strand
   the session history that references it, and an empty directory costs nothing.

## Open questions

- Who sets `meta.cwd` for a Web-created session? The api proxy attaches the
  session after creation and raises `SessionCwdConflict` when an existing
  session's cwd disagrees, which implies the client supplies it from the
  selected workspace. Confirm the anchor path actually arrives as `meta.cwd`
  before building on it, because the whole approach rests on that.
- The stock picker (`@deepseek-ai/dsh-client-ui-workspace`) is a folder browser
  registered into the sidebar and empty-state slots. Browsing to an empty anchor
  is a poor way to start work on a repository. A replacement slot registration
  offering "add a repository" is probably needed for this to feel right, which
  is client-side work and a separate task.
- An empty directory that claims to be a project is mildly dishonest and will
  confuse anyone who `cd`s into it. Consider a `README` inside the anchor
  explaining what it is, which costs one file write and removes the surprise.

## Exit criteria

- A Web session started against a repository appears under a correctly titled
  workspace in the sidebar, not under Ungrouped.
- Two sessions on the same repository group under one workspace.
- Two sessions on different repositories group separately.
- `dsh --profile headless` behaves exactly as before, with no anchor created and
  no registry call attempted.
