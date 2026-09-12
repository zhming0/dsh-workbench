/**
 * The skills this package ships to every sandboxed session.
 *
 * One module per skill, each exporting an `AuthoredSkill`, listed here. The
 * list is explicit so a missing or renamed file fails the build instead of
 * silently dropping a skill from every session's catalog.
 *
 * A skill's prose lives beside its module as Markdown and is read at load
 * time, so a sentence changes as ordinary Markdown rather than as an escaped
 * string literal. The module names its own body through `skillMarkdown`:
 *
 *   // my-skill.ts
 *   import { skillMarkdown, type AuthoredSkill } from "../skills.js";
 *
 *   export const mySkill: AuthoredSkill = {
 *     name: "my-skill",
 *     description: "…",
 *     content: skillMarkdown(import.meta.url),   // reads ./my-skill.md
 *   };
 *
 * Then list the module:
 *
 *   import { mySkill } from "./my-skill.js";
 *
 *   export const skills: readonly AuthoredSkill[] = [mySkill];
 */

import type { AuthoredSkill } from "../skills.js";

import { usingAgentBrowser } from "./using-agent-browser.js";

export const skills: readonly AuthoredSkill[] = [usingAgentBrowser];
