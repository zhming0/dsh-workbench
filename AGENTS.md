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
npm pack @deepseek-ai/dsh-base@0.1.1-rc.2
tar xzf *.tgz
# package/README.md is the spec. package/lib/*.js is the built source, which is
# readable and worth grepping when a README leaves a detail open. A bundle also
# carries package/cordis.patch.yml, the rows it contributes.
```

This repository pins `0.1.1-rc.2`. Match it, because the surface moves between
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
| How a Web session is created, including its `cwd` | `@deepseek-ai/dsh-host-apiproxy`                        |

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
- A session's working directory falls back through selected workspace, then
  request payload, then `process.cwd()`. It is always set, and dsh creates the
  directory if it is missing.
- `shell` is built on top of `subprocess`, so `subprocess` is the seam that
  decides where a command actually runs.
- `tool-fs-search` (`glob`, `grep`) injects `subprocess`, not `fs`, and spawns a
  ripgrep binary resolved from the dsh host's `node_modules`. On its own it
  cannot work against a remote filesystem; this repository's sandbox subprocess
  seam translates host-frame workdirs and host-only executables so the stock
  row still runs inside the sandbox. The package's `search` row
  (`@zhming0/dsh-workbench/search`) is the exact implementation, but shipped
  agent presets that restate the row by stock name load the stock row.
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

## Test the affected path

For TypeScript or protobuf changes, run:

```sh
pnpm check
pnpm format:check
pnpm test
pnpm build
```

For runner changes, also run:

```sh
(cd runner && go test -race ./... && go vet ./... && go build ./...)
```

Run `pnpm test:docker` for Docker lifecycle, runner protocol, setup, credential,
or sandbox tool changes. Run the kind scripts in `scripts/kas/` for Kubernetes
lifecycle or manifest changes. Regenerate protobuf code and confirm there is no
generated-code diff when the contract or generator settings change.

Update the relevant README or `docs/` page when behavior, configuration,
security boundaries, setup, or supported limits change.
