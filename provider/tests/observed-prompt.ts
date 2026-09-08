/**
 * The host-only prompt paragraphs exactly as the pinned dsh packages compose
 * them, including their interpolation placeholders rendered here as
 * \${…} literal text. Both the marker fixtures and the wording tripwire
 * derive from this file, so a dsh rewording has one place to land. Sources
 * at 0.1.2-rc.1: addHarnessSourceSection in @deepseek-ai/dsh-app-boot and
 * webSurfacePrompt in @deepseek-ai/dsh-web-app.
 */

/** The checkout paragraph; \${sourceRoot} is the host dsh install root. */
export const HARNESS_SOURCE_TEMPLATE =
  "The DeepSeek Harness implementation checkout is at ${sourceRoot}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.";

/** The Web GUI paragraph; \${webUrl} is the host GUI base URL. */
export const WEB_SURFACE_TEMPLATE =
  'You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. The browser provides no implicit DOM, route, or screenshot context. The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while \\`pnpm run dev:web\\` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. Starting another server does not update this GUI. The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.';
