# Using agent-browser in a sandbox

`agent-browser` and Chrome for Testing (Chromium) are preinstalled in every
sandbox. Run `agent-browser skills get core --full` first; it is the
version-matched reference for commands, refs, sessions, restore, and
recording. This skill adds only what the sandbox changes.

## Environment

- The browser runs inside the sandbox. It can open `http://localhost:<port>`
  dev servers directly. Only the user needs portal URLs, so share the portal
  URL with the user and never the localhost URL you browsed.
- Chrome for Testing is preinstalled as `google-chrome` on `PATH`, which the
  CLI searches by itself. If it still reports no browser, run
  `agent-browser install`; that copy lands under `$HOME`, which works for the
  current session but does not survive a sandbox wake.
- For a self-signed HTTPS dev server, pass `--ignore-https-errors` and
  `--args "--allow-running-insecure-content"` on the first `open`. Prefer an
  HTTP port when the server offers one.
- Pass the identical `--args` value on every command for that session, or
  wrap the invocation in a script. A changed or missing `--args` value
  relaunches Chrome without the flags, silently. `--args` splits on every
  comma, so a comma-valued Chrome flag cannot go through it; use an
  `--executable-path` wrapper instead (see Hover-gated UI).
- Save every screenshot and recording the user should see under
  `/workspace/.agents/artifacts/` by absolute path. That directory sits on the
  sandbox's workspace volume but outside the repository checkout, so media
  stays reachable and a capture never shows up as an untracked file in the
  repo. `/tmp` and anything else off that volume does not survive a wake and
  shows as a broken placeholder. A path starting with `.` is read as a CSS
  selector, which is the other reason to pass the path in full.

## Sessions

- Reuse one named `--session` for a whole workflow. Keep at most three live
  sessions in one namespace; reuse or close one instead of opening a fourth.
  Keep session names to 20 characters or fewer so the Unix socket path stays
  under its 103-byte limit.
- Close sessions as soon as their part of the workflow ends, and before
  memory-heavy work such as test suites or builds.
- The browser daemon dies on sandbox pause and resume, on CLI restarts, and
  after an idle hour. Pass bare `--restore` on every command for a session
  that must keep login state. Restore keeps cookies and storage only: after a
  relaunch, `open <full URL>` (not bare `reload`) and reapply
  `set viewport`, `set device`, and `set media`.
- `[agent-browser] restore: missing; save: saved` is startup metadata, not a
  failure.
- A shell helper that creates sessions installs an `EXIT` trap as soon as it
  knows the session names; a Node or TypeScript helper closes them in
  `finally`. Call cleanup explicitly on the success path too; a hard command
  timeout can skip the trap, so run cleanup in the next command after a
  timeout.

```bash
export AGENT_BROWSER_NAMESPACE=checkout-flow
SESSIONS=(buyer admin)
cleanup() {
	for session in "${SESSIONS[@]}"; do
		agent-browser --session "$session" --restore close >/dev/null 2>&1 || true
	done
}
trap cleanup EXIT

agent-browser --session buyer --restore open "$BUYER_URL"
agent-browser --session admin --restore open "$ADMIN_URL"
for session in "${SESSIONS[@]}"; do
	agent-browser --session "$session" --restore set viewport 1280 720 2
done

# workflow
cleanup
trap - EXIT
```

## Screenshots

- Screenshots must be 2x (`devicePixelRatio` 2); 1x looks blurry on retina
  displays. Run `set viewport <w> <h> 2` after the first `open` of a new or
  restarted session and after any `set viewport` that omits the scale, which
  resets that tab to 1x. Check with `eval devicePixelRatio` before capturing.
  Image pixel coordinates are then 2x the CSS values; selector clips are
  unaffected. Recordings stay at 1x.
- A repository `agent-browser.json` merges over the sandbox defaults field by
  field, but a file named by `AGENT_BROWSER_CONFIG` replaces them; keep the
  scale flag if you set that. The image leaves the agent-browser configuration
  alone, so a repository config still merges.
- `set viewport`, `set device`, and init scripts apply to the current tab
  only. A popup opened by page code (`window.open`, `target=_blank`) gets
  neither; `tab new <url>` and `click <selector> --new-tab` replay init
  scripts but not the viewport. Open new pages with `tab new <url>` instead
  of triggering a popup, and after `tab <id>` onto any new tab check
  `eval devicePixelRatio` and rerun `set viewport <w> <h> 2` if it is not 2.
- Wait for the element, text, URL, or app-specific ready signal before every
  capture. After a viewport change, wait for two animation frames:
  `eval "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"`.
- Pass a selector or ref as the first `screenshot` argument only when the
  element sits inside the initial unscrolled viewport. Selector captures clip
  against the unscrolled surface, so below-the-fold or scrolled elements come
  out blank white and `scrollintoview` does not fix it. For those, scroll and
  capture the viewport without a selector, or capture `--full` and crop.
- Capture every representative affected state, not only the default one: open,
  selected, empty, loading, and error states when the change touches them.
- Inspect every capture with the media viewing tool before reporting it. For
  exact colors or measurements, sample pixels with Python and Pillow instead
  of judging by eye.
- Use `set viewport <w> <h> 2` at several widths for breakpoint checks. A
  390-pixel Chromium capture proves the narrow layout only; it is not a phone
  capture (see Touch and mobile).

## Hover-gated UI

Headless Chromium reports no input device: `(hover: none)` matches and
`(pointer: fine)` does not. Hover-gated UI such as tooltips never appears on
`hover` or `mouse move`, and touch fallbacks render in screenshots. To test
hover, relaunch through a wrapper that adds the Blink settings:

```bash
cat > /tmp/chrome-desktop-pointer.sh <<'INNER_EOF'
#!/usr/bin/env bash
set -euo pipefail
exec google-chrome \
	'--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4' \
	"$@"
INNER_EOF
chmod +x /tmp/chrome-desktop-pointer.sh
agent-browser --session app close
agent-browser --session app --executable-path /tmp/chrome-desktop-pointer.sh open "<url>"
```

Verify `eval "matchMedia('(hover: hover)').matches"` is `true` before
trusting hover results. A relaunch without the wrapper reverts.

## Touch and mobile

`agent-browser` itself is Chromium-only and never emulates touch. `set viewport`
and `set device` change size, DPR, and user agent only, so `(pointer: coarse)`
stays unmatched and `(hover: none)` matches. Touch-only styles change sizes,
spacing, and layout, so a `set device` capture is not what the UI looks like on
a phone. Never present one as a phone screenshot, and do not claim touch
behaviour was verified from it.

When a task really does need touch or mobile layout, drive Playwright against
the browser that is already installed instead of installing another one. The
image's `google-chrome` is Chrome for Testing, which is Chromium, so a device
profile with `hasTouch` does make `(pointer: coarse)` match and `.tap()` does
fire touch events. What does not work here is `playwright install`, with or
without `--with-deps`: the flag needs root for shared libraries and a session
is an unprivileged user with no `sudo`. Passing `executablePath` skips that
step entirely, and `playwright-core` needs no browser download:

```bash
mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
```

```js
const { chromium, devices } = require("playwright-core");

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
});
const context = await browser.newContext({ ...devices["iPhone 14"] });
const page = await context.newPage();
await page.goto(url);
if (!(await page.evaluate(() => matchMedia("(pointer: coarse)").matches))) {
  throw new Error("device profile did not apply");
}
await page.locator("#submit").tap();
await page.screenshot({ path: "/workspace/.agents/artifacts/mobile.png" });
await browser.close();
```

- Assert `(pointer: coarse)` before trusting a result, as above. A profile that
  silently failed to apply otherwise looks exactly like a passing run.
- The full descriptor is what does it; `hasTouch` and `isMobile` are the fields
  that matter. A Pixel descriptor covers Android Chrome the same way.
- This is emulation, not a real device. Say which descriptor was used and that
  the capture came from desktop Chromium wearing a phone profile.
- Safari-only rendering is still out of scope: WebKit is a different engine
  whose libraries this image does not carry, and installing them needs root.
  Confirm those on a real device or another environment, and say they were not
  checked here.

Chromium at several viewport widths remains the cheaper check for responsive
layout, and it needs nothing but `set viewport`.

## Troubleshooting

- There is no `mouse click` subcommand. Use `click <selector-or-ref>`; for
  coordinates, use `mouse move <x> <y>`, `mouse down left`,
  `mouse up left`.
- Do not retry a hanging command in a loop. Run
  `agent-browser doctor --offline --quick`, inspect the session, then close
  and reopen it.
- If `open` reports `CDP command timed out: Page.navigate`, run `get url`
  once. If it shows the expected destination, continue.
- `batch` step strings strip quotes. For quoted JavaScript or selectors, pass
  a JSON array of argument arrays on stdin:
  `agent-browser batch <<'JSON'` … `[["open","https://example.com"],["eval","document.title"]]`.
- Wrap multi-statement `eval` in an IIFE or block. Top-level `const` and
  `let` persist across calls in a session and cause
  `Identifier has already been declared`.
- The sandbox's agent-browser build has no runtime `addinitscript` command.
  Pass `--init-script <path>` when launching the browser instead.
- If `open` lands on `about:blank` or `snapshot` shows
  `(no interactive elements)` for a local HTTPS server, relaunch with the
  HTTPS flags from Environment on the first `open`.
