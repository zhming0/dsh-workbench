/**
 * The skills this package ships to every sandboxed session.
 *
 * One folder per skill, each with an `index.ts` exporting an `AuthoredSkill`
 * and a `SKILL.md` beside it, listed here. The list is explicit so a missing
 * or renamed file fails the build instead of silently dropping a skill from
 * every session's catalog.
 *
 * To add one:
 *
 *   // my-skill/index.ts
 *   import { skillMarkdown, type AuthoredSkill } from "../../skills.js";
 *
 *   export const mySkill: AuthoredSkill = {
 *     name: "my-skill",
 *     description: "…",
 *     content: skillMarkdown(import.meta.url),   // reads ./SKILL.md
 *   };
 *
 *   // index.ts
 *   import { mySkill } from "./my-skill/index.js";
 *
 *   export const skills: readonly AuthoredSkill[] = [mySkill];
 */

import type { AuthoredSkill } from "../skills.js";

import { usingAgentBrowser } from "./using-agent-browser/index.js";

export const skills: readonly AuthoredSkill[] = [usingAgentBrowser];
