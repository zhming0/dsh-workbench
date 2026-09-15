# Using a browser in a sandbox

`agent-browser` is installed in every sandbox; the browser it drives is not.
Chrome, the libraries it links against, and a font are installed on first use,
into the workspace volume, where a wake keeps them.

```bash
install-browser
. "$HOME/.local/share/agent-browser-env.sh"
```

`install-browser` is idempotent, so run it every session: a sandbox that
already has the browser returns immediately. Load the environment file in every
command that drives the browser, in the same shell: `LD_LIBRARY_PATH` and
`PATH` do not survive between tool calls.

Then drive the browser with `agent-browser`. It ships its own version-matched
reference for its commands and flags, which this skill does not repeat:

```bash
agent-browser skills get core --full
```

## What this sandbox changes

- The generated wrapper always passes `--no-sandbox`, because the sandbox
  blocks the kernel feature Chrome's own sandbox needs, and
  `--disable-dev-shm-usage`, because `/dev/shm` is 64 MB. This is only safe in
  a sandbox that is disposable by design; do not load untrusted pages into it.
- Write screenshots and recordings the user should see to
  `/workspace/.agents/artifacts/` by absolute path. That directory is on the
  workspace volume but outside the checkout, so reads reach it, a wake keeps
  it, and a capture never lands as an untracked file in the repository. A path
  starting with `.` is read as a CSS selector, so pass the full path.
- `set viewport` and `set device` change size, DPR, and user agent only: they
  never make `(pointer: coarse)` match, so a `set device` capture is not what
  the UI looks like on a phone. When a task needs real touch, drive Playwright
  against the browser that is already installed. `playwright-core` with
  `executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH` and a context
  from `devices["iPhone 14"]` (or a Pixel descriptor) does make
  `(pointer: coarse)` match and `.tap()` fire touch events. Never run
  `playwright install`, which needs root. WebKit is out of scope: a different
  engine whose libraries this image does not carry.
