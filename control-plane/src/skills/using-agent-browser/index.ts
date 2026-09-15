import { skillMarkdown, type AuthoredSkill } from "../../skills.js";

/**
 * Teaches sandboxed sessions to drive a browser.
 *
 * Both the CLI and its bootstrap live in the runner image, and the CLI ships
 * its own version-matched reference, so this skill covers only what the
 * sandbox changes: installing the browser on first use, where media must be
 * written to be visible to the user, and the container flags the wrapper
 * already carries.
 */
export const usingAgentBrowser: AuthoredSkill = {
  name: "using-agent-browser",
  description:
    "Install and drive a headless browser to inspect and test web UIs, capture screenshots and recordings, and verify touch, hover, and responsive behaviour.",
  whenToUse:
    "Use when a task needs a real browser: checking a dev server, exercising a UI flow, capturing screenshots, or verifying visual and responsive behaviour.",
  content: skillMarkdown(import.meta.url),
};
