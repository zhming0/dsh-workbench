# Repository guidance

## Learn what dsh is before you change anything

dsh is DeepSeek Harness, an agent harness that shipped in 2026 as a pre-1.0
developer preview. It is almost certainly not in your training data, and there
is little public documentation. Do not guess its API or its behavior. Every
claim you make about dsh should come from a file you read.

The authoritative documentation is each npm package's own README, and those
READMEs are unusually detailed and precise. Read them directly:

```sh
cd "$(mktemp -d)"
npm pack @deepseek-ai/dsh-base@0.1.2-rc.1
tar xzf *.tgz
# package/README.md is the spec. package/lib/*.js is the built source, which is
# readable and worth grepping when a README leaves a detail open. A bundle also
# carries package/cordis.patch.yml, the rows it contributes.
```

This repository pins `0.1.2-rc.1`. Match it, because the surface moves between
release candidates.

### The model

dsh is a [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) plugin
tree, composed at boot. Plugins publish services under a name (`fs`, `shell`,
`subprocess`, `agents`) and consume them with `static inject`. This package
supplies its own implementations of three of those services, so dsh's built-in
tools use a sandbox without knowing one exists.

| Term              | What it means                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Profile**       | One installed tree, at `$DSH_HOME/profiles/<name>/` (`$DSH_HOME` defaults to `~/.dsh`). Holds `package.json` with the ordered `dsh.profile.bundles` list, plus your `cordis.patch.yml`.                               |
| **Bundle**        | An npm package declaring `dsh.bundle.patch`. Its patch file becomes a layer. This package is one.                                                                                                                     |
| **Patch layer**   | A YAML list of `{id, name, config}` rows plus `insert:` and `disabled:`. Layers apply over an empty list: bundles in order, then the profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then `--patch`. |
| **Agent preset**  | A per-session composition at `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`, picked in the Web UI. Different from a profile.                                                                                        |
| **Isolate realm** | `cordis:group` with `isolate:` gives a subtree its own copy of named services. A preset must use one for any service it publishes.                                                                                    |

### Which package answers which question

| Question                                          | Read                                                    |
| ------------------------------------------------- | ------------------------------------------------------- |
| Profiles, `dsh plugin`, launcher flags            | `@deepseek-ai/dsh`                                      |
| Patch layer precedence, `$DSH_HOME`, boot         | `@deepseek-ai/dsh-app-boot`                             |
| Which row ids exist, and their defaults           | `@deepseek-ai/dsh-base` (read `cordis.patch.yml`)       |
| What each surface changes                         | `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless` |
| Per-session compositions                          | `@deepseek-ai/dsh-agent-presets`                        |
| User settings document and namespaces             | `@deepseek-ai/dsh-settings`                             |
| The interfaces this repo implements               | `@deepseek-ai/dsh-fs`, `-shell`, `-subprocess`          |
| How a Web session is created, including its `cwd` | `@deepseek-ai/dsh-api-session-controller`               |

### Verified facts that contradict a reasonable guess

Each of these was checked against the packages above. They are the ones most
likely to mislead you.

- `dsh plugin --profile <n> add <pkg>` is `pnpm add` in the profile directory
  and nothing more. A package without `dsh.bundle.patch` installs as a plain
  dependency and wires up nothing.
- A patch entry **replaces** the matched row's whole `config`. It does not deep
  merge, so an override must restate every field it keeps.
- `dsh web` starts a server and prints a URL. It does not start a session;
  sessions are created from the browser.
- The printed URL carries a per-process `?token=`. `GET /` without it, or
  without the cookie it mints, returns 401; static assets stay public. The
  cookie is bound to the `Host` the browser used and is signed with a secret
  kept in `$DSH_HOME/.credentials.yaml`, so it survives host restarts.
- A session's working directory falls back through selected workspace, then
  request payload, then `process.cwd()`. It is always set, and dsh creates the
  directory if it is missing.
- `shell` is built on top of `subprocess`, so `subprocess` is the seam that
  decides where a command actually runs.
- `tool-fs-search` (`glob`, `grep`) injects `subprocess`, not `fs`, and spawns a
  ripgrep binary resolved from the dsh host's `node_modules`, with the session
  cwd and the model's search root in host coordinates. On its own it cannot
  work against a remote filesystem; this repository's sandbox subprocess seam
  translates the workdir, session-frame argv paths, and host-only executables
  so the stock row runs inside the sandbox.
- On the Web surface, tool rows are mounted by agent presets, and a preset
  row's `name:` is the module that loads. A bundle patch that renames a tool
  row (`tool-fs-search: name: ...`) is not what Web sessions run: the shipped
  presets restate the row by its stock name, and the launcher force-sets the
  preset roots after every patch layer, so a bundle cannot add, remove, or
  patch presets. Make stock rows work through the three capability seams
  instead of replacing them.
- A plugin appears in the Web Plugins settings tab only if it both registers a
  settings namespace on the host and ships a hand-written browser card. A
  namespace alone renders nothing.

## Write code people can maintain

- Prefer plain English, direct names, and small functions with one clear job.
- Make the smallest change that fully solves the problem. Avoid speculative
  configuration, wrappers, and abstractions.
- Keep comments for decisions and non-obvious constraints. Do not narrate code
  that is already easy to read.
- Follow the existing style in the package you are changing.

## Respect the system boundaries

- `provider/` owns session lifecycle, credentials, and the Docker and
  Kubernetes backends.
- `runner/` owns commands and file operations inside one sandbox.
- `proto/` is the source of truth for the ConnectRPC contract between them.
- The runner dials out to the host's tunnel listener and authenticates with
  the shared registration token; RPCs then flow host→runner over that
  runner-initiated connection. Do not add a listener on the runner for the
  host to dial, and do not give the runner any other channel back to the dsh
  host.
- Keep host paths and sandbox paths separate. Model-facing file and shell work
  must resolve inside the session's sandbox workspace.
- Preserve lifecycle meaning: hibernation keeps workspace data, wake reuses it,
  and expiry removes it.

## Preserve the supported product

- The product is the Kubernetes distribution: the host and runner images are
  released together. Docker and checkout installs are development paths.
- Only `dsh web` is supported. Headless mode exits before the idle lifecycle can
  run.
- One dsh host is one trust domain. Its sessions, credentials, and sandboxes are
  not isolated from other users admitted to that host.
- Secrets are global to the host and are pushed to a runner before commands.
  `GITHUB_TOKEN` also supplies Git credentials for github.com. There is no
  GitHub device flow or per-repository secret scoping.
- Sandbox code can read injected secrets by design. Keep credentials in the
  provider store, never in pod configuration or workspace files. The one
  deliberate exception is the shared registration token: warm pods must hold
  it before any session exists, so it lives in the `dsh-registration-token`
  Secret. It only lets a runner register a tunnel; it grants nothing else.
- The Kubernetes backend uses one cluster-owned template and warm pool. Do not
  let repositories select pod privileges or arbitrary templates.

## Protect credentials and generated code

- Never write tokens or secret values into a workspace, log, test fixture, or
  committed file. The provider stores credentials; the runner holds delivered
  values in memory.
- Do not hand-edit generated protobuf files. Change `proto/` and run
  `pnpm proto:generate`.
- The pinned dsh, agent-sandbox, Go, `jj`, and `mise` versions are intentional.
  Update them only as part of an explicit compatibility change.
- `mise.toml` is the only place CI and local development read tool versions
  from. Do not reintroduce a version in a pipeline image, a step script, or the
  README. pnpm is the exception: `packageManager` in `package.json` pins it.

## Inspect Buildkite CI

Use `bk`, pinned in `mise.toml`, to inspect this repository's CI in the
`zhming0` organization and `dsh-workbench` pipeline. Prefer the pre-provisioned
`BUILDKITE_API_TOKEN`; it takes precedence over the credential store and legacy
config, and `BUILDKITE_ORGANIZATION_SLUG` selects the organization, so no login
is needed when they are set. Do not run `bk auth login --device` or any
interactive login unless the user explicitly asks. If the token is absent,
report that and stop. When explicitly asked to log in from a headless sandbox,
run `bk auth login --device --credential-store shm`; then confirm with
`bk auth status`.

## Test the affected path

For TypeScript or protobuf changes, run:

```sh
pnpm check
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

For runner changes, also run:

```sh
(cd runner && go test -race ./... && golangci-lint run && go build ./...)
```

Run `pnpm test:docker` for Docker lifecycle, runner protocol, setup, credential,
or sandbox tool changes. Run `pnpm test:kas` for provider-to-runner transport,
Kubernetes lifecycle, or manifest changes. Regenerate protobuf code and confirm
there is no generated-code diff when the contract or generator settings change.

Follow [`docs/e2e-testing.md`](docs/e2e-testing.md) for the complete Docker,
Kubernetes, and browser/model acceptance workflows, including expected results,
cleanup, and failure investigation.

Update the relevant README or `docs/` page when behavior, configuration,
security boundaries, setup, or supported limits change.
