import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import type { SkillCandidate, SkillProvider } from "@deepseek-ai/dsh-skill";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SKILLS_PROVIDER,
  SKILLS_RANK,
  apply,
  createSkillsProvider,
  registerSkills,
  skillMarkdown,
  type AuthoredSkill,
} from "../src/skills.js";
import { skills } from "../src/skills/index.js";

const usable: AuthoredSkill = {
  name: "usable-skill",
  description: "A skill a sandboxed session can load.",
  content: "Do the thing.",
};

const another: AuthoredSkill = {
  name: "another-skill",
  description: "Another skill.",
  content: "Another body.",
};

/** The candidate shape the provider serves, for the "unknown name" case. */
const foreignCandidate = {
  name: "unknown-skill",
  description: "Never served.",
  invocation: { modelInvocable: true, userInvocable: true },
  source: "authored",
  provider: SKILLS_PROVIDER,
  rank: SKILLS_RANK,
  locator: "unknown-skill",
};

/** `list()` also accepts an observation form; the provider serves the array. */
async function listCandidates(provider: SkillProvider) {
  const listed = await provider.list({});
  if (!Array.isArray(listed)) {
    throw new Error("provider returned an observation instead of candidates");
  }
  return listed as readonly SkillCandidate[];
}

describe("createSkillsProvider", () => {
  it("serves a candidate the registry accepts", async () => {
    const { provider } = createSkillsProvider([usable]);

    await expect(listCandidates(provider)).resolves.toMatchObject([
      {
        name: "usable-skill",
        provider: SKILLS_PROVIDER,
        rank: SKILLS_RANK,
        locator: "usable-skill",
      },
    ]);
  });

  it("carries whenToUse onto the candidate when authored", async () => {
    const { provider } = createSkillsProvider([
      { ...usable, whenToUse: "When the thing needs doing." },
    ]);

    await expect(listCandidates(provider)).resolves.toMatchObject([
      { whenToUse: "When the thing needs doing." },
    ]);
  });

  it("serves the body for its own candidate", async () => {
    const { provider } = createSkillsProvider([usable]);
    const [candidate] = await listCandidates(provider);
    if (candidate === undefined) {
      throw new Error("provider listed no candidate");
    }

    await expect(provider.get(candidate, {})).resolves.toMatchObject({
      name: "usable-skill",
      content: "Do the thing.",
      invocation: { modelInvocable: true, userInvocable: true },
    });
  });

  it("honours an authored invocation policy", async () => {
    const { provider } = createSkillsProvider([
      {
        ...usable,
        invocation: { modelInvocable: false, userInvocable: true },
      },
    ]);
    const [candidate] = await listCandidates(provider);
    if (candidate === undefined) {
      throw new Error("provider listed no candidate");
    }

    await expect(provider.get(candidate, {})).resolves.toMatchObject({
      invocation: { modelInvocable: false, userInvocable: true },
    });
  });

  it("has no body for a name it never served", async () => {
    const { provider } = createSkillsProvider([usable]);

    await expect(provider.get(foreignCandidate, {})).resolves.toBeUndefined();
  });

  it("keeps the first of two same-name skills and reports the clash", async () => {
    const { provider, duplicates } = createSkillsProvider([
      usable,
      { ...usable, content: "A second, ignored body." },
    ]);

    expect(duplicates).toEqual(["usable-skill"]);
    const candidates = await listCandidates(provider);
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    if (candidate === undefined) {
      throw new Error("provider listed no candidate");
    }
    await expect(provider.get(candidate, {})).resolves.toMatchObject({
      content: "Do the thing.",
    });
  });

  it("keeps every distinct name", async () => {
    const { provider, duplicates } = createSkillsProvider([usable, another]);

    expect(duplicates).toEqual([]);
    const candidates = await listCandidates(provider);
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      "usable-skill",
      "another-skill",
    ]);
  });
});

async function makeRegistry(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SkillRegistry);
  return ctx;
}

describe("skillMarkdown", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-workbench-skills-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reads the sibling file named after the module", async () => {
    await writeFile(join(directory, "my-skill.md"), "Skill body.\n");

    const body = skillMarkdown(
      pathToFileURL(join(directory, "my-skill.js")).href,
    );

    expect(body).toBe("Skill body.\n");
  });

  it("reads an explicitly named file", async () => {
    await writeFile(join(directory, "other.md"), "Other body.\n");

    const body = skillMarkdown(
      pathToFileURL(join(directory, "my-skill.js")).href,
      "other.md",
    );

    expect(body).toBe("Other body.\n");
  });

  it("fails at load, naming the file, when the body is absent", () => {
    expect(() =>
      skillMarkdown(pathToFileURL(join(directory, "missing.js")).href),
    ).toThrow(/missing\.md/);
  });

  it("fails on an empty body rather than serving a blank skill", async () => {
    await writeFile(join(directory, "blank.md"), "  \n\n");

    expect(() =>
      skillMarkdown(pathToFileURL(join(directory, "blank.js")).href),
    ).toThrow(/is empty/);
  });

  it("drops the module extension whatever it is", async () => {
    await writeFile(join(directory, "typed.md"), "Typed body.\n");

    const body = skillMarkdown(pathToFileURL(join(directory, "typed.ts")).href);

    expect(body).toBe("Typed body.\n");
  });
});

describe("registerSkills", () => {
  it("makes the skills listable and loadable through the registry", async () => {
    const ctx = await makeRegistry();

    registerSkills(ctx, [usable, another]);

    const catalog = await ctx.skills.list();
    // The registry sorts the merged catalog by name.
    expect(catalog.map((skill) => skill.name)).toEqual([
      "another-skill",
      "usable-skill",
    ]);
    // The body must load, not just list: a runtime registration produces a
    // catalog entry whose load fails, which this row must avoid.
    await expect(ctx.skills.get("usable-skill")).resolves.toMatchObject({
      content: "Do the thing.",
    });
    await expect(ctx.skills.get("another-skill")).resolves.toMatchObject({
      content: "Another body.",
    });
  });

  it("warns about a duplicate instead of letting it decide the body", async () => {
    const warnings: string[] = [];
    const ctx = await makeRegistry();
    ctx.logger.warn = (message: string) => {
      warnings.push(message);
    };

    registerSkills(ctx, [
      usable,
      { ...usable, content: "A second, ignored body." },
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("usable-skill");
    await expect(ctx.skills.get("usable-skill")).resolves.toMatchObject({
      content: "Do the thing.",
    });
  });

  it("registers nothing for an empty skills list", async () => {
    const ctx = await makeRegistry();

    registerSkills(ctx, []);

    await expect(ctx.skills.list()).resolves.toEqual([]);
  });

  it("removes the skills when the mounted row is disposed", async () => {
    const ctx = await makeRegistry();
    const plugin = await ctx.plugin({
      name: "skills-under-test",
      inject: ["skills"],
      apply: (scoped: Context) => registerSkills(scoped, [usable]),
    });

    await expect(ctx.skills.list()).resolves.toHaveLength(1);

    await plugin.dispose();
    await expect(ctx.skills.list()).resolves.toEqual([]);
  });
});

describe("apply", () => {
  it("serves the shipped list, bodies read from the Markdown files", async () => {
    const ctx = await makeRegistry();

    await apply(ctx);

    const catalog = await ctx.skills.list();
    expect(catalog.map((skill) => skill.name).sort()).toEqual(
      skills.map((skill) => skill.name).sort(),
    );
    // Every shipped entry must carry the body from its own file: this fails
    // if a skill stops declaring one, or if the read breaks or comes back
    // empty. It cannot prove file identity, because the body is read from
    // that same file at load.
    for (const skill of skills) {
      const bodyPath = fileURLToPath(
        new URL(`../src/skills/${skill.name}.md`, import.meta.url),
      );
      const definition = await ctx.skills.get(skill.name);
      expect(definition?.content).toBe(readFileSync(bodyPath, "utf8"));
    }
  });

  it("serves an injected list, bodies included", async () => {
    const ctx = await makeRegistry();

    await apply(ctx, [usable, another]);

    const catalog = await ctx.skills.list();
    expect(catalog.map((skill) => skill.name)).toEqual([
      "another-skill",
      "usable-skill",
    ]);
    await expect(ctx.skills.get("usable-skill")).resolves.toMatchObject({
      content: "Do the thing.",
    });
    await expect(ctx.skills.get("another-skill")).resolves.toMatchObject({
      content: "Another body.",
    });
  });

  it("is inert when there is nothing to serve", async () => {
    const ctx = await makeRegistry();

    await apply(ctx, []);

    await expect(ctx.skills.list()).resolves.toEqual([]);
  });
});
