import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { describe, expect, it } from "vitest";

import {
  SANDBOX_ENVIRONMENT_PROMPT,
  SANDBOX_ENVIRONMENT_SECTION,
  apply,
  dropHostOnlySections,
  installSandboxContext,
  isHostOnlySection,
} from "../src/sandbox-context.js";
import {
  HARNESS_SOURCE_TEMPLATE,
  WEB_SURFACE_TEMPLATE,
} from "./observed-prompt.js";

// The paragraphs as the model sees them: the verbatim composer templates
// (tests/observed-prompt.ts, also asserted against the live packages by
// tests/dsh-prompt-wording.test.ts) with the interpolation placeholders
// filled to this deployment's values.
const CHECKOUT_SECTION = HARNESS_SOURCE_TEMPLATE.replace(
  "${sourceRoot}",
  "/usr/local/lib/node_modules/@deepseek-ai/dsh/",
);
const GUI_SECTION = WEB_SURFACE_TEMPLATE.replace(
  "${webUrl}",
  "http://127.0.0.1:3000",
);
const IDENTITY_SECTION = "You are an AI agent powered by DeepSeek Harness.";
const PERSONA_SECTION = "You are the deployment assistant.";
const BASH_TOOL_SECTION = "Prefer bash for file and process operations.";

/** A recording systemPrompt stub. */
function makeSystemPromptStub() {
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const variables = new Map<string, (context: unknown) => string | undefined>();
  return {
    sections,
    variables,
    getSectionOrder: () => 0,
    section(section: { name: string; order: number; text: string }) {
      sections.push(section);
    },
    variable(name: string, provider: (context: unknown) => string | undefined) {
      variables.set(name, provider);
    },
  };
}

describe("isHostOnlySection", () => {
  it("matches the observed host-only sections", () => {
    expect(isHostOnlySection(CHECKOUT_SECTION)).toBe(true);
    expect(isHostOnlySection(GUI_SECTION)).toBe(true);
  });

  it("leaves ordinary sections alone", () => {
    expect(isHostOnlySection(IDENTITY_SECTION)).toBe(false);
    expect(isHostOnlySection(PERSONA_SECTION)).toBe(false);
    expect(isHostOnlySection(BASH_TOOL_SECTION)).toBe(false);
    expect(isHostOnlySection(SANDBOX_ENVIRONMENT_PROMPT)).toBe(false);
  });
});

describe("dropHostOnlySections", () => {
  it("drops exactly the host-only sections and keeps the rest in order", () => {
    const sections = [
      { name: "harness:identity", text: IDENTITY_SECTION },
      { name: "harness:source", text: CHECKOUT_SECTION },
      { name: "web:surface", text: GUI_SECTION },
      { name: "deployment:persona", text: PERSONA_SECTION },
      { name: "tool:bash", text: BASH_TOOL_SECTION },
    ];
    const dropped = dropHostOnlySections(sections);
    expect(dropped).toBe(2);
    expect(sections.map((section) => section.name)).toEqual([
      "harness:identity",
      "deployment:persona",
      "tool:bash",
    ]);
  });

  it("keeps other assembly fields untouched", () => {
    const sections = [{ name: "harness:source", text: CHECKOUT_SECTION }];
    const assembly = {
      sections,
      contexts: [{ name: "policy", text: "keep" }],
      variables: { cwd: "/workspace/repository" },
    };
    dropHostOnlySections(assembly.sections);
    expect(assembly.sections).toEqual([]);
    expect(assembly.contexts).toEqual([{ name: "policy", text: "keep" }]);
    expect(assembly.variables.cwd).toBe("/workspace/repository");
  });

  it("is a no-op when nothing matches", () => {
    const sections = [{ name: "deployment:persona", text: PERSONA_SECTION }];
    expect(dropHostOnlySections(sections)).toBe(0);
    expect(sections).toHaveLength(1);
  });
});

describe("installSandboxContext", () => {
  it("registers the environment section and the sandbox cwd variable", () => {
    const systemPrompt = makeSystemPromptStub();
    installSandboxContext(systemPrompt, () => "/workspace/repository");
    expect(systemPrompt.sections).toEqual([
      {
        name: SANDBOX_ENVIRONMENT_SECTION,
        order: 0,
        text: SANDBOX_ENVIRONMENT_PROMPT,
      },
    ]);
    expect(systemPrompt.variables.get("cwd")?.({})).toBe(
      "/workspace/repository",
    );
  });

  it("resolves the workspace lazily on each assembly", () => {
    const systemPrompt = makeSystemPromptStub();
    let workspace = "/workspace/one";
    installSandboxContext(systemPrompt, () => workspace);
    expect(systemPrompt.variables.get("cwd")?.({})).toBe("/workspace/one");
    workspace = "/workspace/two";
    expect(systemPrompt.variables.get("cwd")?.({})).toBe("/workspace/two");
  });

  it("references the cwd variable from the section text", () => {
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain("{{cwd}}");
  });

  it("carries the GUI paragraph's still-true this-page mapping", () => {
    expect(SANDBOX_ENVIRONMENT_PROMPT).toContain('"this page"');
    expect(isHostOnlySection(SANDBOX_ENVIRONMENT_PROMPT)).toBe(false);
  });
});

describe("apply", () => {
  it("filters host-only sections through the assemble waterfall", async () => {
    const ctx = new Context();
    ctx.provide("sandboxManager", { workspace: "/workspace/repository" });
    ctx.provide("agents", { list: () => [] });
    apply(ctx);

    const assembly = {
      sections: [
        { name: "harness:identity", text: IDENTITY_SECTION },
        { name: "harness:source", text: CHECKOUT_SECTION },
        { name: "web:surface", text: GUI_SECTION },
      ],
      contexts: [],
      tools: [],
      variables: {},
    };
    const result = (await ctx.events.waterfall(
      {},
      "system-prompt/assemble",
      assembly,
      {},
      () => Promise.resolve(assembly),
    )) as { sections: Array<{ name: string }> };
    expect(result.sections.map((section) => section.name)).toEqual([
      "harness:identity",
    ]);
  });

  it("warns once when nothing matches, making reworded dsh sections visible", async () => {
    const ctx = new Context();
    ctx.provide("sandboxManager", { workspace: "/workspace/repository" });
    ctx.provide("agents", { list: () => [] });
    const warnings: string[] = [];
    ctx.logger.warn = (message: string) => {
      warnings.push(message);
    };
    apply(ctx);

    const dispatch = async (
      sections: Array<{ name: string; text: string }>,
    ) => {
      const assembly = { sections, contexts: [], tools: [], variables: {} };
      await ctx.events.waterfall(
        {},
        "system-prompt/assemble",
        assembly,
        {},
        () => Promise.resolve(assembly),
      );
    };
    await dispatch([{ name: "deployment:persona", text: PERSONA_SECTION }]);
    await dispatch([{ name: "deployment:persona", text: PERSONA_SECTION }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no host-only prompt sections matched");
  });
});

describe("against the pinned dsh-system-prompt service", () => {
  it("drops the host-only sections from a real assembly", async () => {
    const ctx = new Context();
    const systemPrompt = new SystemPrompt(ctx, {
      includeHarnessIdentity: true,
      includeRuntimeContext: true,
      persona: PERSONA_SECTION,
    });
    systemPrompt.section({
      name: "harness:source",
      order: systemPrompt.getSectionOrder("HARNESS_SOURCE"),
      text: CHECKOUT_SECTION,
    });
    systemPrompt.section({
      name: "web:surface",
      order: systemPrompt.getSectionOrder("WEB_SURFACE"),
      text: GUI_SECTION,
    });

    const assembly = await systemPrompt.assemble({});
    expect(assembly.sections.map((section) => section.name)).toEqual([
      "harness:identity",
      "harness:source",
      "web:surface",
      "deployment:persona",
    ]);
    expect(dropHostOnlySections(assembly.sections)).toBe(2);
    expect(assembly.sections.map((section) => section.name)).toEqual([
      "harness:identity",
      "deployment:persona",
    ]);
  });
});
