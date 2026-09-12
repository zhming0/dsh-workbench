/**
 * TypeScript-authored skills for every sandboxed session.
 *
 * The stock skill provider (`dsh-skill-filesystem`) discovers skills from
 * disk, and this bundle's filesystem seam reads that disk inside the sandbox.
 * Project roots work there because the checkout is cloned to the same path,
 * but the user-level roots do not: `$DSH_HOME/skills` is a host path, so a
 * `SKILL.md` placed there never reaches a sandboxed session. Skills authored
 * as modules beside this file sidestep that boundary entirely — the plugin
 * serves them from memory, and nothing is read from either machine's disk at
 * session time.
 *
 * To add a skill, write a module in `skills/` and list it in `skills/index.ts`.
 * The list is explicit rather than a directory scan because these are
 * TypeScript modules: a scan could only find compiled `.js` files, so a build
 * that put them elsewhere would leave the catalog silently empty. An import
 * either resolves at build time or fails it.
 *
 * @module @zhming0/dsh-workbench/skills
 */

import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type {
  SkillCandidate,
  SkillDefinition,
  SkillProvider,
  SkillSummary,
} from "@deepseek-ai/dsh-skill";

/** Provider label reported for authored skills. */
export const SKILLS_PROVIDER = "authored";

/**
 * Source label for authored skills. `SkillSource` is open, so a deployment tag
 * describes these better than the stock buckets, which all name a disk
 * location these skills deliberately do not have.
 */
export const SKILLS_SOURCE = "authored";

/**
 * Precedence rank for authored skills: the bundled tier, so a repository's own
 * `.agents/skills` (rank 200) still wins a name collision. Matches the
 * registry's `BUNDLED_SKILL_RANK`.
 */
export const SKILLS_RANK = 600;

/**
 * Read a skill's Markdown body from the file beside its module.
 *
 * Synchronous on purpose: modules call this at load time, so a missing,
 * unreadable, or empty body fails as the module loads, naming the file, rather
 * than surfacing later as a skill that lists but cannot be read. The path
 * resolves from `import.meta.url`, so it follows the module into `dist`, where
 * the build copies the Markdown. The extension is dropped whatever it is,
 * because the same module is a `.ts` under the test runner and a `.js` once
 * built — and vitest resolves that `.ts` in place, so tests read the same
 * source file this comment sits beside.
 *
 * @param moduleUrl - the calling module's `import.meta.url`.
 * @param name - body file name; defaults to `<module>.md`.
 * @returns the file's text, verbatim.
 */
export function skillMarkdown(moduleUrl: string, name?: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const body = name ?? `${basename(modulePath, extname(modulePath))}.md`;
  const path = join(dirname(modulePath), body);
  const content = readFileSync(path, "utf8");
  if (content.trim().length === 0) {
    throw new Error(`skill body "${path}" is empty`);
  }
  return content;
}

/**
 * One authored skill: the fields a module defines, which is a skill summary
 * plus its instruction body.
 */
export type AuthoredSkill = Omit<
  SkillSummary,
  "invocation" | "source" | "provider"
> &
  Partial<Pick<SkillSummary, "invocation">> & {
    readonly content: string;
  };

/**
 * Turn authored skills into a registry provider.
 *
 * Duplicate names cannot reach the registry: two entries claiming one name
 * would otherwise let provider order decide which body a session gets, so the
 * first in list order wins and the clash is returned for the caller to report.
 *
 * @param skills - the authored skills, in list order.
 * @returns the provider plus the duplicate names it dropped.
 */
export function createSkillsProvider(skills: readonly AuthoredSkill[]): {
  provider: SkillProvider;
  duplicates: string[];
} {
  const definitions = new Map<string, AuthoredSkill>();
  const duplicates: string[] = [];
  for (const skill of skills) {
    if (definitions.has(skill.name)) {
      duplicates.push(skill.name);
      continue;
    }
    definitions.set(skill.name, skill);
  }

  const candidates = new Map<string, SkillCandidate>(
    [...definitions.values()].map((skill) => [
      skill.name,
      {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined
          ? {}
          : { whenToUse: skill.whenToUse }),
        invocation: skill.invocation ?? {
          modelInvocable: true,
          userInvocable: true,
        },
        source: SKILLS_SOURCE,
        provider: SKILLS_PROVIDER,
        rank: SKILLS_RANK,
        locator: skill.name,
      },
    ]),
  );

  return {
    provider: {
      name: SKILLS_PROVIDER,
      list: () => Promise.resolve([...candidates.values()]),
      get: (candidate) => {
        const skill = definitions.get(candidate.name);
        if (skill === undefined) {
          return Promise.resolve(undefined);
        }
        const definition: SkillDefinition = {
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse === undefined
            ? {}
            : { whenToUse: skill.whenToUse }),
          invocation: skill.invocation ?? {
            modelInvocable: true,
            userInvocable: true,
          },
          source: SKILLS_SOURCE,
          provider: SKILLS_PROVIDER,
          content: skill.content,
        };
        return Promise.resolve(definition);
      },
    },
    duplicates,
  };
}

export const name = "skills";
export const inject = ["skills"];

/**
 * Register the authored skills into the global layer of the skill registry,
 * which every agent's merged catalog carries. Registration lives as long as
 * this row's fiber, so disposing the row removes the skills and invalidates
 * the catalogs that carried them.
 *
 * @param ctx - plugin context carrying the skill registry.
 * @param skills - the authored skills, from `skills/index.ts`.
 */
export function registerSkills(
  ctx: Context,
  skills: readonly AuthoredSkill[],
): void {
  const { provider, duplicates } = createSkillsProvider(skills);
  for (const duplicate of duplicates) {
    ctx.logger.warn(
      `skills: "${duplicate}" is authored more than once; the first wins`,
    );
  }
  ctx.effect(
    () => ctx.skills.registerProvider(() => provider),
    `skills: ${SKILLS_PROVIDER} provider`,
  );
}

/**
 * Mount the authored skills.
 *
 * @param ctx - plugin context carrying the skill registry.
 * @param authored - the skills to serve; defaults to the shipped list in
 *   `skills/index.ts`. Injectable so tests can mount a known set.
 */
export async function apply(
  ctx: Context,
  authored?: readonly AuthoredSkill[],
): Promise<void> {
  const listed = authored ?? (await import("./skills/index.js")).skills;
  registerSkills(ctx, listed);
}
