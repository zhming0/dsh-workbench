# Web sidebar against the sandbox

## Status

Deferred. dsh 0.1.5-rc.1 added a right sidebar to the Web surface, with a
**Files** tab (workspace tree), a **Preview** tab (Markdown, code, HTML, PDF,
plain text), and clickable file references under each assistant turn. This
bundle disables those rows (`workspace-files`, `ui-sidebar-files`,
`ui-sidebar-documentpreview`, `ui-deliverables` in `provider/cordis.patch.yml`)
because making them work against the sandbox costs more code than the sidebar
is worth today: it shows the same files GitHub shows once the agent pushes,
and the part a user cannot get from GitHub — unpushed work in progress — is
readable by asking the model.

One piece of that surface is not waiting for this plan: the chat renders an
inline preview for image files the model declares with `present`
(`provider/src/presented-images.ts` and the `presented-image` half of the
provider), so a picture shows up in the conversation without any tab. This
plan covers the sidebar's own Files, Preview, and file-reference rows.

Revisit when the sidebar carries something the sandbox alone can give: a
terminal tab, a browser preview of a port inside the sandbox, or a workflow
where people review unpushed deliverables in dsh rather than on GitHub. Neither
a terminal nor a browser tab would reuse the work below; they need a streaming
shell over the runner tunnel and port forwarding out of the sandbox.

A complete implementation, verified end to end on Docker with a real model
session, exists as commit `0ec541d` (branch `sidebar/never-wake`). Its design
and the facts it depends on are recorded here so the branch can be rebased or
redone without rediscovering them.

## Why the stock rows fail

Every fact below was checked against the 0.1.5-rc.1 package sources.

- `@deepseek-ai/dsh-api-workspace-files` (`static inject = ["fs",
"sandboxPolicy", "sessions", "typert"]`) serves the browser over the RPC
  bridge. Each method takes a `workspaceFileScope` that the gateway resolves
  from the wire's session id into `{sessionId, workspaceRoot}`, where
  `workspaceRoot` is the session header `cwd`, and then calls `ctx.fs` with no
  agent context. Against the stock host filesystem that is fine.
- This bundle's `SandboxFileSystem` picks a runner per session through
  `ctx.agents.requireInitiator()`, which reads an `AsyncLocalStorage` that the
  agent loop sets around a turn and throws "no initiator" outside one. Model
  tool calls always run inside a turn, so `fs`, `shell`, and `subprocess` work
  unchanged; sidebar requests never do, so every list, read, and stat fails.
- `workspace-files` and `ui-deliverables` hard-inject `sandboxPolicy`, and dsh
  refuses to boot while a mounted row waits for a missing service. This
  bundle disables the stock `sandbox-policy` row because its prompt line names
  the host anchor cwd, so either both rows stay off or a stand-in must publish
  `sandboxPolicy`.
- The Web app serves a package's browser half (`dsh.client` in its
  `package.json`) only while a row of that package is mounted. The sidebar's
  file resource provider is the browser half of `workspace-files`, so
  disabling that row while leaving the tab rows mounted makes Preview report
  "The file resource service is unavailable"; the tab rows have to go with it.
  Conversely, replacing the row with a subclass under a different module name
  loses the browser half, and a patch entry's `name:` is an assertion that
  `dsh-app-boot` rejects with a warning when it differs from the stock module.
  The only way to change what the stock service does is to keep its row and
  wrap the live instance.
- `ui-sidebar-right` (the docking surface) must stay mounted regardless: the
  chat UI's browser half injects `sidebarRight`. With no tab rows it renders
  empty.
- Optional readers of `sandboxPolicy` do not force the stand-in: `tool-fs` and
  `tool-bash` call `ctx.get("sandboxPolicy")` only when a confining backend
  sets a default mode, and the sandbox backends do not. `dsh-terminal-bash`
  hard-injects it but is not mounted by the Web patch; the shipped `minimal`
  preset uses it and already fails to compose on this bundle.

## Design of the deferred implementation

### Slice one: run the stock service as the session's agent

Two host rows, both in the bundle's `insert:` list; the stock `workspace-files`
row stays mounted.

`sandbox-workspace-policy` (`provider/src/sandbox-policy.ts`, 73 lines)
publishes `sandboxPolicy` with the sandbox workspace as `workspaceRoot`, no
per-session mode override, and no prompt line. It exists only so the two Web
rows can compose.

`sandbox-workspace-files` (`provider/src/workspace-files.ts`, 175 lines in
this slice) waits for `workspaceFiles`, `agents`, `sessionController`, and
`sandboxManager` with `ctx.inject` rather than `static inject`, so a headless
profile without the Web-only services still boots. It takes the live stock
instance (`Reflect.get(scope.workspaceFiles, symbols.original)`) and installs
own-property wrappers for `read`, `readBytes`, `readAll`, `readRelated`,
`stat`, `list`, and `changes`. Each wrapper resolves the scope's session to an
agent with `sessionController.resolveAgent(sessionId)` (live agent, or a
resumed stored session) and runs the stock method inside
`agents.withInitiator(agent, ...)`. The stock prototype methods and their
remote markers, which the gateway reads, are untouched, and disposing the row
removes the wrappers.

No path translation is needed: the scope's `workspaceRoot` is the session cwd
on the host, and `SandboxFileSystem.resolve` already maps the session cwd onto
the sandbox workspace for the agent it runs as, so every path the browser gets
back is a sandbox path. One cosmetic limit remains: the Files tab's header
label comes from the session `cwd` in the browser and shows the host anchor
directory.

In this slice a browse wakes a hibernated sandbox and counts as activity for
the idle timer, like any other request. `sandbox-manager` is untouched.

### Slice two: the sidebar never wakes a sandbox

The browser lists the root whenever a Files tab opens, re-reads a previewed
file after every WebSocket reconnect, and re-opens its change feed the same
way, so none of that may decide when a sandbox runs. This slice is what made
the implementation large (+707 lines across 10 files, including
`sandbox-manager` and `sandbox-lifecycle`). Only carry it if wake-on-browse
turns out to matter in practice.

- `SandboxLifecycle.runningClient(sessionId)`: under the session lock, returns
  the live runner only when the record state is `running` (cached attachment,
  else backend health check and reconnect without setup); never provisions,
  wakes, or recovers.
- `SandboxManager`: an `AsyncLocalStorage` flag set by `withoutWake(op)`, under
  which `clientForCurrentAgent()` answers only for a running sandbox and throws
  `SandboxNotRunningError` otherwise; `runningClient(agent)`; and
  `onceRunning(agent, signal)`, a waiter notified at the end of
  `ensureRunning`. Passive lookups do not re-arm the idle timer.
- `workspace-files` when the sandbox is not running: `list` answers from the
  file index saved at hibernation (the same index `@` uses, so `.git`,
  `node_modules`, and the other excluded names are missing and the entry cap
  applies); `read`, `readBytes`, `readAll`, `readRelated`, and `stat` throw
  `RemoteError("workspace-file/sandbox-hibernated", "The sandbox is
hibernated. Send a message to wake it.")`, which Preview shows with a Retry
  button; `changes` yields `{kind: "ready"}` at once so the browser can stat
  and learn the state, awaits `onceRunning`, then delegates to the stock feed
  dropping its own `ready`. With no index (host restarted while running, or
  the walk failed) `list` reports the hibernated error too.
- Stock browser behavior to know about: the first failed body read is sticky
  until Retry, even after the sandbox wakes; and only fs-tool writes emit
  `fs/observed` change frames, shell writes do not.

Verified on Docker: with the record `hibernated` and no runner container, the
Files tab listed from the index and Preview showed the hibernated message; a
prompt that edited the file woke the sandbox and the open preview reported the
change; Retry loaded it; with Preview left open the sandbox hibernated again on
its idle schedule.

## Open question

Whether slice two is needed at all, or wake-on-browse is acceptable. The
answer depends on how often people leave a Files or Preview tab open on an
idle session; only usage decides it.
