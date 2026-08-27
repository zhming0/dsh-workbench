# Repository guidance

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
- The provider always connects to the runner. Do not add a connection from the
  runner back to the dsh host.
- Keep host paths and sandbox paths separate. Model-facing file and shell work
  must resolve inside the session's sandbox workspace.
- Preserve lifecycle meaning: hibernation keeps workspace data, wake reuses it,
  and expiry removes it.

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
