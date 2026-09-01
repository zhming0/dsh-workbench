import { describe, expect, it } from "vitest";

import type { Context } from "@deepseek-ai/cordis";
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

import { apply, testing } from "../src/search.js";

const SESSION_WORKSPACE = "/data/.dsh-sandbox/workspace-anchors/owner-repo";
const SANDBOX_WORKSPACE = "/workspace/repository";

const defaults = {
  globMaxResults: 100,
  grepMaxMatches: 250,
  grepMaxLineBytes: 2000,
  rawOutputMaxBytes: 20_000_000,
  graceMs: 3000,
  stderrMaxBytes: 65_536,
  timeoutMs: 30_000,
};

interface RegisteredTool {
  name: string;
  execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>;
}

function execFrom(sessionCwd: string): ToolRunContext {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: sessionCwd } } },
  } as unknown as ToolRunContext;
}

function fakeContext(stdout: string, exitCode: number) {
  const spawned: SubprocessSpawnSpec[] = [];
  const tools: RegisteredTool[] = [];
  const sections: { name: string; order: number; text: string }[] = [];
  const subprocess = {
    resolveExecutable: async () => "/usr/local/bin/rg",
    spawn(spec: SubprocessSpawnSpec) {
      spawned.push(spec);
      return {
        pid: 7,
        collected: {
          stdout: {
            readFrom: () => ({
              text: stdout,
              nextOffset: Buffer.byteLength(stdout),
              lossy: false,
            }),
          },
          stderr: {
            readFrom: () => ({ text: "", nextOffset: 0, lossy: false }),
          },
        },
        done: Promise.resolve({ exitCode, signal: null }),
      } as unknown as SubprocessHandle;
    },
  };
  const ctx = {
    systemPrompt: { section: (section: never) => sections.push(section) },
    tools: { register: (tool: never) => void tools.push(tool) },
    subprocess,
    sandboxManager: { workspace: SANDBOX_WORKSPACE },
  } as unknown as Context;
  return { ctx, spawned, tools, sections };
}

function toolNamed(fake: ReturnType<typeof fakeContext>, name: string) {
  const tool = fake.tools.find((candidate) => candidate.name === name);
  expect(tool, `tool ${name} was not registered`).toBeDefined();
  return tool!;
}

describe("search commands", () => {
  it("builds the fixed rg --files argv for glob", () => {
    expect(testing.buildGlobCommand({ pattern: "**/*.ts" })).toEqual([
      "--files",
      "--glob=**/*.ts",
      "--sort=modified",
      "--no-ignore",
      "--hidden",
      "--glob=!**/.git",
      "--glob=!**/.git/**",
      "--glob=!**/.svn",
      "--glob=!**/.svn/**",
      "--glob=!**/.hg",
      "--glob=!**/.hg/**",
      "--glob=!**/.bzr",
      "--glob=!**/.bzr/**",
      "--glob=!**/.jj",
      "--glob=!**/.jj/**",
      "--glob=!**/.sl",
      "--glob=!**/.sl/**",
    ]);
    expect(testing.buildGlobCommand({ pattern: "*.md", path: "docs" })).toEqual(
      testing.buildGlobCommand({ pattern: "*.md" }).concat("--", "docs"),
    );
  });

  it("builds the fixed rg --json argv for grep", () => {
    expect(
      testing.buildGrepCommand({ pattern: "alpha" }, "/workspace/repo"),
    ).toEqual(["--json", "--regexp=alpha", "--", "/workspace/repo"]);
    expect(
      testing.buildGrepCommand(
        {
          pattern: "alpha",
          include: "*.ts",
          path: "src",
        },
        "/workspace/repo",
      ),
    ).toEqual(["--json", "--regexp=alpha", "--glob=*.ts", "--", "src"]);
  });

  it("rejects include values that are not one positive glob", () => {
    expect(() => testing.validateInclude("!src")).toThrow(/negated/);
    expect(() => testing.validateInclude("a,b")).toThrow(/comma-separated/);
    expect(() => testing.validateInclude("   ")).toThrow(/non-empty/);
    expect(() => testing.validateInclude("*.{ts,tsx}")).not.toThrow();
  });

  it("translates only the search root into sandbox coordinates", () => {
    expect(
      testing.translateSearchRoot(
        ["--json", "--regexp=x", "--", `${SESSION_WORKSPACE}/src`],
        SESSION_WORKSPACE,
        SANDBOX_WORKSPACE,
      ),
    ).toEqual(["--json", "--regexp=x", "--", `${SANDBOX_WORKSPACE}/src`]);
    expect(
      testing.translateSearchRoot(
        ["--json", "--regexp=x", "--", "src"],
        SESSION_WORKSPACE,
        SANDBOX_WORKSPACE,
      ),
    ).toEqual(["--json", "--regexp=x", "--", "src"]);
    expect(
      testing.translateSearchRoot(
        ["--json", "--regexp=x", "--", `${SANDBOX_WORKSPACE}/src`],
        SESSION_WORKSPACE,
        SANDBOX_WORKSPACE,
      ),
    ).toEqual(["--json", "--regexp=x", "--", `${SANDBOX_WORKSPACE}/src`]);
    expect(
      testing.translateSearchRoot(
        ["--files"],
        SESSION_WORKSPACE,
        SANDBOX_WORKSPACE,
      ),
    ).toEqual(["--files"]);
  });

  it("maps tool arguments through path validation", () => {
    expect(testing.parseGlobArgs({ pattern: "*.ts" })).toEqual({
      pattern: "*.ts",
    });
    expect(() => testing.parseGlobArgs({ pattern: "   " })).toThrow(
      /non-empty/,
    );
    expect(() => testing.parseGlobArgs({ pattern: "*", path: "  " })).toThrow(
      /non-empty/,
    );
    expect(() => testing.parseGrepArgs({ pattern: "" })).toThrow(/non-empty/);
    expect(() =>
      testing.parseGrepArgs({ pattern: "x", include: "!src" }),
    ).toThrow(/negated/);
  });
});

describe("grep output parsing", () => {
  it("consumes match records and skips the rest", () => {
    const stdout = [
      JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "a.ts" },
          line_number: 3,
          lines: { text: "const alpha = 1;\n" },
        },
      }),
      JSON.stringify({ type: "context", data: {} }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "b.ts" },
          line_number: 8,
          lines: {
            bytes: Buffer.from("ok", "utf8").toString("base64"),
          },
        },
      }),
      JSON.stringify({ type: "summary", data: {} }),
    ].join("\n");
    expect(testing.parseGrepMatches(stdout)).toEqual([
      { path: "a.ts", lineNumber: 3, line: "const alpha = 1;" },
      { path: "b.ts", lineNumber: 8, line: "(line is not valid UTF-8)" },
    ]);
  });

  it("fails malformed output as SEARCH_FAILED", () => {
    try {
      testing.parseGrepMatches("not json");
      expect.unreachable();
    } catch (error) {
      expect(testing.SearchError).toBeDefined();
      expect((error as { code: string }).code).toBe("SEARCH_FAILED");
    }
    const missingLine = JSON.stringify({
      type: "match",
      data: { path: { text: "a.ts" }, lines: { text: "x" } },
    });
    expect(() => testing.parseGrepMatches(missingLine)).toThrow(
      testing.SearchError,
    );
  });
});

describe("retention and formatting", () => {
  it("previews lines at a UTF-8-safe byte cut", () => {
    expect(testing.previewLine("short", 100)).toBe("short");
    const cut = testing.previewLine("x".repeat(50), 10);
    expect(cut).toBe(`${"x".repeat(10)} (line truncated)`);
    const emoji = "😀".repeat(5);
    expect(testing.previewLine(emoji, 10)).toBe("😀😀 (line truncated)");
  });

  it("retains the head of a match list", () => {
    const matches = Array.from({ length: 5 }, (_, index) => ({
      path: "a.ts",
      lineNumber: index + 1,
      line: `l${index}`,
    }));
    const retained = testing.retainGrepMatches(matches, {
      maxMatches: 3,
      maxLineBytes: 2000,
    });
    expect(retained.items).toHaveLength(3);
    expect(retained.seen).toBe(5);
    expect(retained.kept).toBe(3);
    expect(retained.truncated).toBe(true);
  });

  it("formats grep results with capped-result wording", () => {
    const empty = testing.retainGrepMatches([], {
      maxMatches: 3,
      maxLineBytes: 2000,
    });
    expect(testing.formatRetainedGrep(empty)).toBe("No matches found");
    const two = [
      { path: "a.ts", lineNumber: 1, line: "x" },
      { path: "a.ts", lineNumber: 2, line: "y" },
    ];
    expect(
      testing.formatRetainedGrep(
        testing.retainGrepMatches(two, { maxMatches: 3, maxLineBytes: 2000 }),
      ),
    ).toBe("Found 2 matches\n\na.ts\nLine 1: x\nLine 2: y");
    const five = Array.from({ length: 5 }, (_, index) => ({
      path: "a.ts",
      lineNumber: index + 1,
      line: `l${index}`,
    }));
    const capped = testing.formatRetainedGrep(
      testing.retainGrepMatches(five, { maxMatches: 3, maxLineBytes: 2000 }),
    );
    expect(capped).toContain("Found 3 of 5 matches");
    expect(capped).toContain("(Narrow pattern, path, or include to see more.)");
  });

  it("formats glob results with capped-result wording", () => {
    expect(testing.renderGlobPaths([], { maxResults: 3 })).toBe(
      "No files found",
    );
    expect(testing.renderGlobPaths(["a.ts", "b.ts"], { maxResults: 3 })).toBe(
      "a.ts\nb.ts",
    );
    expect(
      testing.renderGlobPaths(["a", "b", "c", "d"], { maxResults: 3 }),
    ).toBe(
      "a\nb\nc\n\n(Showing 3 of 4 paths. Narrow pattern or path to see more.)",
    );
  });

  it("relativizes display paths against the workdir", () => {
    expect(
      testing.toWorkdirRelative(
        `${SANDBOX_WORKSPACE}/src/a.ts`,
        SANDBOX_WORKSPACE,
      ),
    ).toBe("src/a.ts");
    expect(testing.toWorkdirRelative("src/a.ts", SANDBOX_WORKSPACE)).toBe(
      "src/a.ts",
    );
    expect(testing.toWorkdirRelative("/etc/hosts", SANDBOX_WORKSPACE)).toBe(
      "/etc/hosts",
    );
  });
});

describe("sandbox search tools", () => {
  it("registers glob and grep with their prompt guidance", () => {
    const fake = fakeContext("", 1);
    apply(fake.ctx, defaults);
    expect(fake.tools.map((tool) => tool.name)).toEqual(["glob", "grep"]);
    expect(fake.sections.map((section) => section.name)).toEqual([
      "tool:glob",
      "tool:grep",
    ]);
  });

  it("runs glob in the sandbox and translates the search root", async () => {
    const fake = fakeContext("src/a.ts\nsrc/b.ts\n", 0);
    apply(fake.ctx, defaults);
    const glob = toolNamed(fake, "glob");
    const result = (await glob.execute(
      { pattern: "*.ts", path: `${SESSION_WORKSPACE}/src` },
      execFrom(SESSION_WORKSPACE),
    )) as { root: string; paths: string[] };
    expect(result).toEqual({
      root: `${SESSION_WORKSPACE}/src`,
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(fake.spawned).toHaveLength(1);
    const spec = fake.spawned[0]!;
    expect(spec.argv?.[0]).toBe("/usr/local/bin/rg");
    expect(spec.argv?.[1]).toBe("--no-config");
    expect(spec.argv).toContain("--glob=*.ts");
    expect(spec.argv?.slice(-2)).toEqual(["--", `${SANDBOX_WORKSPACE}/src`]);
    expect(spec.cwd).toBe(SANDBOX_WORKSPACE);
    expect(spec.stdio.stdout).toEqual({ maxBytes: defaults.rawOutputMaxBytes });
  });

  it("runs grep in the sandbox and parses match records", async () => {
    const stdout = [
      JSON.stringify({
        type: "begin",
        data: { path: { text: "src/a.ts" } },
      }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "src/a.ts" },
          line_number: 3,
          lines: { text: "export const alpha = 1;\n" },
        },
      }),
      JSON.stringify({ type: "end", data: { path: { text: "src/a.ts" } } }),
    ].join("\n");
    const fake = fakeContext(stdout, 0);
    apply(fake.ctx, defaults);
    const grep = toolNamed(fake, "grep");
    const result = (await grep.execute(
      { pattern: "alpha" },
      execFrom(SESSION_WORKSPACE),
    )) as { matches: { path: string; lineNumber: number; line: string }[] };
    expect(result).toEqual({
      matches: [
        { path: "src/a.ts", lineNumber: 3, line: "export const alpha = 1;" },
      ],
    });
    const spec = fake.spawned[0]!;
    expect(spec.argv?.slice(0, 3)).toEqual([
      "/usr/local/bin/rg",
      "--no-config",
      "--json",
    ]);
    expect(spec.cwd).toBe(SANDBOX_WORKSPACE);
  });

  it("treats a zero-result search as an empty success", async () => {
    const fake = fakeContext("", 1);
    apply(fake.ctx, defaults);
    const glob = toolNamed(fake, "glob");
    const grep = toolNamed(fake, "grep");
    await expect(
      glob.execute({ pattern: "*.missing" }, execFrom(SESSION_WORKSPACE)),
    ).resolves.toEqual({ root: ".", paths: [] });
    await expect(
      grep.execute({ pattern: "nothing" }, execFrom(SESSION_WORKSPACE)),
    ).resolves.toEqual({ matches: [] });
  });

  it("fails with SEARCH_FAILED when ripgrep is missing from the sandbox", async () => {
    const failing = {
      resolveExecutable: async () => {
        throw new Error("executable not found");
      },
      spawn: () => {
        throw new Error("unreachable");
      },
    };
    const tools: RegisteredTool[] = [];
    const ctx = {
      systemPrompt: { section: () => {} },
      tools: { register: (tool: never) => void tools.push(tool) },
      subprocess: failing,
      sandboxManager: { workspace: SANDBOX_WORKSPACE },
    } as unknown as Context;
    apply(ctx, defaults);
    const glob = tools.find((tool) => tool.name === "glob")!;
    await expect(
      glob.execute({ pattern: "*.ts" }, execFrom(SESSION_WORKSPACE)),
    ).rejects.toMatchObject({ code: "SEARCH_FAILED" });
  });
});
