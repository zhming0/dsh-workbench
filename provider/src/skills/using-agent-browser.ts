import { skillMarkdown, type AuthoredSkill } from "../skills.js";

/**
 * Teaches sandboxed sessions to drive the preinstalled `agent-browser` CLI.
 *
 * The upstream CLI ships its own version-matched reference, so this skill
 * covers only what this sandbox changes: where the browser runs, where media
 * must be written to be visible to the user, and the headless quirks that
 * follow from running Chrome in a container.
 */
export const usingAgentBrowser: AuthoredSkill = {
  name: "using-agent-browser",
  description:
    "Drive the preinstalled agent-browser CLI to inspect and test web UIs, capture screenshots and recordings, and verify hover, touch, and responsive behaviour.",
  whenToUse:
    "Use when a task needs a real browser: checking a dev server, exercising a UI flow, capturing screenshots, or verifying visual and responsive behaviour.",
  content: skillMarkdown(import.meta.url),
};
