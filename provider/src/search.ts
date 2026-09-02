import { isAbsolute, relative, sep } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import {
  ItemRetainer,
  type RetainedItems,
  TextRetainer,
} from "@deepseek-ai/dsh-output-retention";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import {
  defineTool,
  type ToolCallView,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import z from "@deepseek-ai/schemastery";

import { pathInSandbox } from "./sandbox-path.js";

/**
 * The model-facing `glob` and `grep` tools, backed by ripgrep running inside
 * the session sandbox instead of a binary on the dsh host. The stock
 * `@deepseek-ai/dsh-tool-fs-search` resolves its packaged ripgrep path on the
 * host, and no such path exists inside a sandbox, so this package supplies its
 * own row for the same `tool-fs-search` id: same tool names, schemas, prompt
 * guidance, caps, and error vocabulary, with the execution moved across the
 * remote boundary.
 *
 * The spawn goes through `ctx.subprocess` — this package's sandbox runtime —
 * after resolving `rg` in the sandbox's own PATH (the runner image ships it).
 * Model-facing paths are translated at this tool boundary, where the mapping
 * is exact: the search root after `--` is the only path argument the tools
 * accept, so `pathInSandbox` rewrites exactly that one argv element from the
 * session workspace to the sandbox workspace. Results keep the stock display
 * contract: paths relative to the search directory, which `read` resolves
 * against the same session workspace.
 *
 * Two stock behaviors are deliberately absent. Over-cap results keep only the
 * inline page with a note, because formatted-result spill is a host-side
 * store and this milestone reports truncation instead (the shell tool makes
 * the same trade). And over-cap `glob` always keeps the modification-time
 * head — the sampling variant exists for deployments that choose it, and this
 * one keeps the smaller surface.
 */

const RAW_OUTPUT_MAX_BYTES = 20_000_000;
const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_STDERR_MAX_BYTES = 64 * 1024;
const SEARCH_GRACE_MS = 3_000;
const GREP_MAX_MATCHES = 250;
const GREP_MAX_LINE_BYTES = 2_000;
const GLOB_MAX_RESULTS = 100;

export type SearchErrorCode =
  | "SEARCH_INVALID_PATTERN"
  | "SEARCH_FAILED"
  | "SEARCH_RAW_OUTPUT_OVERFLOW"
  | "SEARCH_ABORTED";

class SearchError extends HarnessError {
  readonly code: SearchErrorCode;
  constructor(
    message: string,
    code: SearchErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, code, options);
    this.code = code;
  }
}

export interface SearchConfig {
  globMaxResults: number;
  grepMaxMatches: number;
  grepMaxLineBytes: number;
  rawOutputMaxBytes: number;
  graceMs: number;
  stderrMaxBytes: number;
  timeoutMs: number;
}

export const Config = z.object({
  globMaxResults: z.number().default(GLOB_MAX_RESULTS),
  grepMaxMatches: z.number().default(GREP_MAX_MATCHES),
  grepMaxLineBytes: z.number().default(GREP_MAX_LINE_BYTES),
  rawOutputMaxBytes: z.number().default(RAW_OUTPUT_MAX_BYTES),
  graceMs: z.number().default(SEARCH_GRACE_MS),
  stderrMaxBytes: z.number().default(SEARCH_STDERR_MAX_BYTES),
  timeoutMs: z.number().default(SEARCH_TIMEOUT_MS),
});

/** Cordis plugin name used by loader diagnostics. */
const name = "sandbox-fs-search";

/** Services required by the sandbox search tool suite. */
const inject = ["tools", "systemPrompt", "subprocess", "sandboxManager"];

/** The sandbox execution world one search runs against. */
interface SandboxSearch {
  readonly subprocess: Context["subprocess"];
  readonly sandboxWorkspace: string;
}

interface SearchCaps {
  readonly rawOutputMaxBytes: number;
  readonly graceMs: number;
  readonly stderrMaxBytes: number;
}

interface GlobCaps extends SearchCaps {
  readonly maxResults: number;
  readonly timeoutMs: number;
}

interface GrepCaps extends SearchCaps {
  readonly maxMatches: number;
  readonly maxLineBytes: number;
  readonly timeoutMs: number;
}

interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

interface SearchRun {
  readonly stdout: string;
  readonly noMatches: boolean;
  readonly workdir: string;
}

//#region lib/types/search-core.js
/**
 * The retained stderr tail as a diagnostic excerpt, with a truncation note when
 * the subprocess seam dropped bytes.
 */
function stderrExcerpt(stderrText: string, truncated: boolean): string {
  const text = stderrText.trim();
  if (text.length === 0) return "";
  return truncated ? `${text} [stderr truncated]` : text;
}

/**
 * Classify a nonzero-exit `rg` run into the search error vocabulary. There is
 * no shell layer, so an exit 127 or shell "command not found" text cannot
 * occur — a launch failure rejects at spawn (see {@link runRipgrep}).
 */
function classifyRunFailure(
  toolName: string,
  exitCode: number,
  stderrText: string,
  stderrTruncated: boolean,
): SearchError {
  const stderr = stderrExcerpt(stderrText, stderrTruncated);
  if (/regex parse error|error parsing glob/i.test(stderr))
    return new SearchError(
      `${toolName} pattern rejected by ripgrep: ${stderr}`,
      "SEARCH_INVALID_PATTERN",
    );
  return new SearchError(
    `${toolName} search failed (exit ${exitCode})${stderr.length > 0 ? `: ${stderr}` : ""}`,
    "SEARCH_FAILED",
  );
}

/**
 * Acquire the COMPLETE raw stdout of a finished run, enforcing
 * `rawOutputMaxBytes` on the in-memory transport. A truncated result means the
 * subprocess seam could not retain complete stdout within the requested
 * budget, so the tool fails clearly instead of parsing a silently-partial
 * stream.
 */
function completeStdout(
  toolName: string,
  stdout: { text: string; lossy: boolean },
  rawOutputMaxBytes: number,
): string {
  const narrow = "narrow pattern, path, or include and retry";
  if (!stdout.lossy) {
    const inlineBytes = Buffer.byteLength(stdout.text, "utf8");
    if (inlineBytes > rawOutputMaxBytes)
      throw new SearchError(
        `${toolName} produced ${inlineBytes} bytes of raw output, over the ${rawOutputMaxBytes}-byte cap; ${narrow}`,
        "SEARCH_RAW_OUTPUT_OVERFLOW",
      );
    return stdout.text;
  }
  throw new SearchError(
    `${toolName} produced more raw output than the subprocess seam retained within the ${rawOutputMaxBytes}-byte cap; ${narrow}`,
    "SEARCH_RAW_OUTPUT_OVERFLOW",
  );
}

/**
 * Translate the one path-carrying argv element — the search root behind `--`
 * — from the session workspace to the sandbox workspace. Relative roots and
 * paths already in sandbox coordinates pass through `pathInSandbox` unchanged.
 */
function translateSearchRoot(
  command: readonly string[],
  sessionWorkspace: string | undefined,
  sandboxWorkspace: string,
): string[] {
  const separator = command.indexOf("--");
  if (separator === -1) return [...command];
  const target = command[separator + 1];
  if (target === undefined) return [...command];
  return [
    ...command.slice(0, separator),
    "--",
    pathInSandbox(target, sessionWorkspace, sandboxWorkspace),
  ];
}

/**
 * Resolve `rg` in the sandbox and run one search with a plain argv vector,
 * returning complete raw stdout, the zero-result flag, and the workdir the
 * command ran in. `exec.signal` is forwarded so the cooperative tool timeout
 * aborts the remote process group through the subprocess seam.
 */
async function runRipgrep(
  search: SandboxSearch,
  exec: ToolRunContext,
  toolName: string,
  command: readonly string[],
  caps: SearchCaps,
): Promise<SearchRun> {
  if (exec.signal.aborted)
    throw new SearchError(
      `${toolName} was aborted before completion (tool timeout or caller cancellation)`,
      "SEARCH_ABORTED",
    );
  const workdir = search.sandboxWorkspace;
  let rgPath: string;
  try {
    rgPath = await search.subprocess.resolveExecutable(
      "rg",
      undefined,
      exec.signal,
    );
  } catch (error) {
    throw new SearchError(
      `${toolName} could not start its search command (ripgrep is not available in the session sandbox)`,
      "SEARCH_FAILED",
      { cause: error },
    );
  }
  let handle: SubprocessHandle;
  try {
    handle = search.subprocess.spawn({
      argv: [
        rgPath,
        "--no-config",
        ...translateSearchRoot(
          command,
          exec.agent?.session.header.cwd,
          workdir,
        ),
      ],
      cwd: workdir,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: caps.rawOutputMaxBytes },
        stderr: { maxBytes: caps.stderrMaxBytes },
      },
      graceMs: caps.graceMs,
      signal: exec.signal,
    });
  } catch (error) {
    if (exec.signal.aborted)
      throw new SearchError(
        `${toolName} was aborted before completion (tool timeout or caller cancellation)`,
        "SEARCH_ABORTED",
      );
    throw new SearchError(
      `${toolName} could not start its search command (ripgrep launch failed)`,
      "SEARCH_FAILED",
      { cause: error },
    );
  }
  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    throw new SearchError(
      `${toolName} could not start its search command (ripgrep launch failed)`,
      "SEARCH_FAILED",
      { cause: error },
    );
  }
  const stdout = handle.collected.stdout?.readFrom(0);
  const stderr = handle.collected.stderr?.readFrom(0);
  if (stdout === undefined || stderr === undefined)
    throw new SearchError(
      `${toolName} search command produced no collected output streams`,
      "SEARCH_FAILED",
    );
  if (exec.signal.aborted)
    throw new SearchError(
      `${toolName} was aborted before completion (tool timeout or caller cancellation)`,
      "SEARCH_ABORTED",
    );
  if (outcome.signal !== null || outcome.exitCode === null)
    throw new SearchError(
      `${toolName} search command was killed by signal ${outcome.signal ?? "(unknown)"}`,
      "SEARCH_FAILED",
    );
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1)
    throw classifyRunFailure(
      toolName,
      outcome.exitCode,
      stderr.text,
      stderr.lossy,
    );
  return {
    stdout: completeStdout(toolName, stdout, caps.rawOutputMaxBytes),
    noMatches: outcome.exitCode === 1,
    workdir,
  };
}

/**
 * Map an `rg` output path to its display form: absolute paths inside the
 * workdir become workdir-relative; everything else (relative output, paths
 * outside the workdir) passes through unchanged. A workdir-relative display
 * path resolves against the session workspace for `read`, so follow-up reads
 * land on the same file the search matched.
 *
 * @param path - one path as ripgrep printed it.
 * @param workdir - the sandbox workdir the command ran in.
 * @returns the workdir-relative display path when possible, else `path` unchanged.
 */
function toWorkdirRelative(path: string, workdir: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(workdir, path);
  if (rel.length === 0) return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`)) return path;
  return rel;
}

/**
 * Bound one matched-line preview to `maxBytes` (UTF-8 boundary preserved) and
 * mark the cut. The cap is a per-line budget fact; the complete line stays in
 * the searched file for `read`.
 */
function previewLine(line: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: "head", maxBytes });
  retainer.push(line);
  const kept = retainer.finish();
  return kept.truncated ? `${kept.text} (line truncated)` : kept.text;
}

/**
 * Apply the shared inline cap to a canonical `grep` match list: preview each
 * retained line to `maxLineBytes` and keep the first `maxMatches`.
 */
function retainGrepMatches(
  matches: readonly GrepMatch[],
  caps: { maxMatches: number; maxLineBytes: number },
): RetainedItems<GrepMatch> {
  const retainer = new ItemRetainer<GrepMatch>({
    kind: "head",
    maxItems: caps.maxMatches,
  });
  for (const match of matches)
    retainer.push({
      ...match,
      line: previewLine(match.line, caps.maxLineBytes),
    });
  return retainer.finish();
}
//#endregion

//#region lib/types/glob.js
/**
 * Directory names ripgrep must never descend into for a discovery listing: VCS
 * metadata directories.
 */
const GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/**
 * Validate value constraints the schema DSL can't express: a non-blank
 * `pattern`, and a non-blank `path` when given. Throws a plain `Error` (an
 * ordinary tool argument error) otherwise.
 */
function parseGlobArgs(args: { pattern: string; path?: string }): {
  pattern: string;
  path?: string;
} {
  if (args.pattern.trim().length === 0)
    throw new Error("pattern must be a non-empty string");
  if (args.path !== undefined && args.path.trim().length === 0)
    throw new Error("path must be a non-empty string when given");
  return args;
}

/**
 * Build the fixed `rg --files` argv for one `glob` call. Every
 * model-controlled value is a plain argv element — no shell layer exists, so
 * no quoting applies; the search root rides behind `--` so a leading-dash
 * path can never be parsed as a flag. `--sort=modified` orders by modification
 * time, `--no-ignore --hidden` searches ignored and hidden files, and
 * {@link GLOB_VCS_EXCLUDES} keeps VCS metadata out.
 */
function buildGlobCommand(input: { pattern: string; path?: string }): string[] {
  const parts = [
    "--files",
    `--glob=${input.pattern}`,
    "--sort=modified",
    "--no-ignore",
    "--hidden",
    ...GLOB_VCS_EXCLUDES.flatMap((vcsName) => [
      `--glob=!**/${vcsName}`,
      `--glob=!**/${vcsName}/**`,
    ]),
  ];
  if (input.path !== undefined) parts.push("--", input.path);
  return parts;
}

/** Format one bounded page and the narrowing advice for its complete result. */
function formatGlobPage(items: readonly string[], seen: number): string {
  const body = items.join("\n");
  return `${body}\n\n(Showing ${items.length} of ${seen} paths. Narrow pattern or path to see more.)`;
}

/** Bound and format one canonical path list for the model. */
function renderGlobPaths(
  paths: readonly string[],
  caps: { maxResults: number },
): string {
  if (paths.length === 0) return "No files found";
  if (paths.length <= caps.maxResults) return paths.join("\n");
  return formatGlobPage(paths.slice(0, caps.maxResults), paths.length);
}

/**
 * Pending-call presentation: a search card titled by the pattern (and root).
 */
function presentGlobCall(args: {
  pattern: string;
  path?: string;
}): ToolCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : "";
  return {
    card: "generic",
    title: `Glob ${args.pattern}${where}`,
    kind: "search",
    rawInput: args.pattern,
  };
}

/**
 * Register the `glob` tool and its system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `subprocess` service.
 * @param search - the sandbox execution world the tool searches.
 * @param caps - the deployment's resolved glob caps (plugin config after defaulting).
 */
function applyGlobTool(
  ctx: Context,
  search: SandboxSearch,
  caps: GlobCaps,
): void {
  ctx.systemPrompt.section({
    name: "tool:glob",
    order: 103,
    text: 'Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level. Results are files only, never directories, and include hidden and ignored files: a result that fits comes back in modification-time order, while a larger one keeps the modification-time-ordered head.',
  });
  const tool = defineTool({
    name: "glob",
    description: `Find files whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded). Up to ${caps.maxResults} paths come back in modification-time order; a larger result returns the first ${caps.maxResults} paths in modification-time order and says so. This tool does not enumerate directory entries.`,
    parameters: {
      pattern: {
        type: "string",
        required: true,
        description:
          'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.',
      },
      path: {
        type: "string",
        description:
          "Directory to search in. Defaults to the session workspace; a relative path resolves against it.",
      },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          root: { type: "string", required: true },
          paths: {
            type: "array",
            required: true,
            items: { type: "string" },
          },
        },
      },
      render: (_args, value) => [
        { type: "text", text: renderGlobPaths(value.paths, caps) },
      ],
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args);
      const run = await runRipgrep(
        search,
        exec,
        "glob",
        buildGlobCommand(input),
        caps,
      );
      const root =
        input.path === undefined
          ? "."
          : toWorkdirRelative(input.path, run.workdir);
      if (run.noMatches) return { root, paths: [] };
      const paths: string[] = [];
      for (const line of run.stdout.split("\n")) {
        if (line.length === 0) continue;
        paths.push(toWorkdirRelative(line, run.workdir));
      }
      return { root, paths };
    },
    presentCall: presentGlobCall,
  });
  ctx.tools.register(tool);
}
//#endregion

//#region lib/types/grep.js
/**
 * Reject an `include` that is not ONE positive glob filter: blank strings,
 * negated patterns (`!…`), and comma-separated lists. A comma inside a brace
 * group is fine — `*.{ts,tsx}` is one glob with alternation, not a list.
 */
function validateInclude(include: string): void {
  if (include.trim().length === 0)
    throw new Error("include must be a non-empty glob when given");
  if (include.startsWith("!"))
    throw new Error(
      'include must be a positive glob filter; negated patterns ("!…") are not supported',
    );
  let braceDepth = 0;
  for (const char of include)
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "," && braceDepth === 0)
      throw new Error(
        "include must be one glob, not a comma-separated list (use {a,b} alternation instead)",
      );
}

/**
 * Validate value constraints the schema DSL can't express: a non-EMPTY
 * `pattern` (whitespace is a legitimate regex), a non-blank `path` when given,
 * and a single positive `include` glob. Throws a plain `Error` (an ordinary
 * tool argument error) otherwise.
 */
function parseGrepArgs(args: {
  pattern: string;
  path?: string;
  include?: string;
}): { pattern: string; path?: string; include?: string } {
  if (args.pattern.length === 0)
    throw new Error("pattern must be a non-empty string");
  if (args.path !== undefined && args.path.trim().length === 0)
    throw new Error("path must be a non-empty string when given");
  if (args.include !== undefined) validateInclude(args.include);
  return args;
}

/**
 * Build the fixed line-oriented `rg --json` argv for one `grep` call. Every
 * model-controlled value is a plain argv element — no shell layer exists, so
 * no quoting applies; the pattern and include ride in `--flag=value` form and
 * the target behind `--`, so a leading-dash value can never be parsed as a flag.
 * The workdir is always the explicit target: with none, ripgrep searches stdin,
 * and the subprocess transport hands it an empty pipe, which would report "no
 * matches" for a workdir full of hits.
 */
function buildGrepCommand(
  input: {
    pattern: string;
    path?: string;
    include?: string;
  },
  workdir: string,
): string[] {
  const parts = ["--json", `--regexp=${input.pattern}`];
  if (input.include !== undefined) parts.push(`--glob=${input.include}`);
  parts.push("--", input.path ?? workdir);
  return parts;
}

/**
 * The uniform malformed-output failure: raw `rg --json` is an internal
 * transport, so missing or invalid response fields cause a search failure, not
 * a partial result.
 */
function malformedRecord(detail: string, cause?: unknown): SearchError {
  return new SearchError(
    `grep received malformed ripgrep --json output (${detail})`,
    "SEARCH_FAILED",
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Parse one `rg --json` NDJSON line into a match, `undefined` for the
 * non-match record types (`begin`/`end`/`context`/`summary`). A line that is
 * not JSON, or a `match` record missing its path / line number / line content,
 * throws {@link SearchError} `SEARCH_FAILED`. A match whose line is not valid
 * UTF-8 (ripgrep sends base64 `bytes` instead of `text`) yields a placeholder
 * preview rather than failing the whole search.
 */
function parseRecord(line: string): GrepMatch | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw malformedRecord("a line is not JSON", error);
  }
  if (typeof parsed !== "object" || parsed === null)
    throw malformedRecord("a record is not an object");
  const record = parsed as Record<string, unknown>;
  if (record.type !== "match") return undefined;
  if (typeof record.data !== "object" || record.data === null)
    throw malformedRecord("a match record has no data");
  const data = record.data as Record<string, unknown>;
  const pathText =
    typeof data.path === "object" && data.path !== null
      ? (data.path as Record<string, unknown>).text
      : undefined;
  if (typeof pathText !== "string")
    throw malformedRecord("a match record has no path text");
  if (typeof data.line_number !== "number")
    throw malformedRecord("a match record has no line number");
  if (typeof data.lines !== "object" || data.lines === null)
    throw malformedRecord("a match record has no line content");
  const lines = data.lines as Record<string, unknown>;
  if (typeof lines.text === "string")
    return {
      path: pathText,
      lineNumber: data.line_number,
      line: lines.text.replace(/\r?\n$/, ""),
    };
  if (typeof lines.bytes === "string")
    return {
      path: pathText,
      lineNumber: data.line_number,
      line: "(line is not valid UTF-8)",
    };
  throw malformedRecord("a match record has neither line text nor bytes");
}

/**
 * Parse complete `rg --json` stdout into flat matches, in output order (ripgrep
 * emits one file's matches contiguously). Only `match` records are consumed.
 */
function parseGrepMatches(stdout: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const match = parseRecord(line);
    if (match !== undefined) matches.push(match);
  }
  return matches;
}

/** `match` / `matches` for a count. */
function matchNoun(count: number): string {
  return count === 1 ? "match" : "matches";
}

/**
 * Group flat matches by file (first-seen order) into the model-facing body:
 * each file's display path, then one `Line N: <text>` row per match.
 */
function formatGrepMatches(matches: readonly GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const group = byFile.get(match.path);
    if (group !== undefined) group.push(match);
    else byFile.set(match.path, [match]);
  }
  const sections: string[] = [];
  for (const [path, group] of byFile)
    sections.push(
      `${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join("\n")}`,
    );
  return sections.join("\n\n");
}

/**
 * Format the model-facing `grep` result: a found-count header, the retained
 * matches grouped by file, then — when the result was capped — a footer
 * telling the model how to see more. The omitted count is a budget fact: the
 * search itself completed.
 */
function formatRetainedGrep(retained: RetainedItems<GrepMatch>): string {
  if (retained.seen === 0) return "No matches found";
  const header = retained.truncated
    ? `Found ${retained.kept} of ${retained.seen} matches`
    : `Found ${retained.seen} ${matchNoun(retained.seen)}`;
  const body = formatGrepMatches(retained.items);
  if (!retained.truncated) return `${header}\n\n${body}`;
  return `${header}\n\n${body}\n\n(Narrow pattern, path, or include to see more.)`;
}

/**
 * Pending-call presentation: a search card titled by the pattern (and target /
 * include filter).
 */
function presentGrepCall(args: {
  pattern: string;
  path?: string;
  include?: string;
}): ToolCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : "";
  const filter = args.include !== undefined ? ` (${args.include})` : "";
  return {
    card: "generic",
    title: `Grep ${args.pattern}${where}${filter}`,
    kind: "search",
    rawInput: args.pattern,
  };
}

/**
 * Register the `grep` tool and its system-prompt guidance.
 *
 * @param ctx - the plugin context; registrations are effects scoped to it, and
 *   execution uses its `subprocess` service.
 * @param search - the sandbox execution world the tool searches.
 * @param caps - the deployment's resolved grep caps (plugin config after defaulting).
 */
function applyGrepTool(
  ctx: Context,
  search: SandboxSearch,
  caps: GrepCaps,
): void {
  ctx.systemPrompt.section({
    name: "tool:grep",
    order: 104,
    text: "Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.",
  });
  const tool = defineTool({
    name: "grep",
    description: `Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Returns the first ${caps.maxMatches} matches inline; a capped result says so. Use read on a matched file for surrounding context.`,
    parameters: {
      pattern: {
        type: "string",
        required: true,
        description: "Regular expression to search for (ripgrep syntax).",
      },
      path: {
        type: "string",
        description:
          "File or directory to search. Defaults to the session workspace; a relative path resolves against it.",
      },
      include: {
        type: "string",
        description:
          'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
      },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          matches: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                lineNumber: { type: "integer", required: true },
                line: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: formatRetainedGrep(retainGrepMatches(value.matches, caps)),
        },
      ],
    },
    async execute(args, exec) {
      const run = await runRipgrep(
        search,
        exec,
        "grep",
        buildGrepCommand(parseGrepArgs(args), search.sandboxWorkspace),
        caps,
      );
      if (run.noMatches) return { matches: [] };
      const matches: GrepMatch[] = [];
      for (const raw of parseGrepMatches(run.stdout))
        matches.push({
          path: toWorkdirRelative(raw.path, run.workdir),
          lineNumber: raw.lineNumber,
          line: raw.line,
        });
      return { matches };
    },
    presentCall: presentGrepCall,
  });
  ctx.tools.register(tool);
}
//#endregion

/** Every search cap counts items/bytes/milliseconds — a positive integer, or retention and timeout arithmetic misbehaves silently. */
function assertPositiveInteger(key: string, value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`sandbox-fs-search: ${key} must be a positive integer`);
}

/**
 * Register the `glob`/`grep` sandbox discovery tool suite. Registration is
 * unconditional: the runner image ships ripgrep, and a sandbox without it
 * fails per call with a clear `SEARCH_FAILED` message instead of hiding the
 * tools.
 *
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration from schemastery.
 */
function apply(ctx: Context, config: SearchConfig): void {
  for (const [key, value] of Object.entries(config))
    assertPositiveInteger(key, value);
  if (config.graceMs > MAX_TIMER_DELAY_MS)
    throw new Error(
      `sandbox-fs-search: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  const search: SandboxSearch = {
    subprocess: ctx.subprocess,
    sandboxWorkspace: ctx.sandboxManager.workspace,
  };
  applyGlobTool(ctx, search, {
    maxResults: config.globMaxResults,
    rawOutputMaxBytes: config.rawOutputMaxBytes,
    graceMs: config.graceMs,
    stderrMaxBytes: config.stderrMaxBytes,
    timeoutMs: config.timeoutMs,
  });
  applyGrepTool(ctx, search, {
    maxMatches: config.grepMaxMatches,
    maxLineBytes: config.grepMaxLineBytes,
    rawOutputMaxBytes: config.rawOutputMaxBytes,
    graceMs: config.graceMs,
    stderrMaxBytes: config.stderrMaxBytes,
    timeoutMs: config.timeoutMs,
  });
}

export const testing = {
  buildGlobCommand,
  buildGrepCommand,
  formatRetainedGrep,
  parseGlobArgs,
  parseGrepArgs,
  parseGrepMatches,
  previewLine,
  renderGlobPaths,
  retainGrepMatches,
  toWorkdirRelative,
  translateSearchRoot,
  validateInclude,
  SearchError,
};

export { apply, inject, name };
