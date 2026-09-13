import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  WorkspaceFiles,
  type WorkspaceFileScope,
} from "@deepseek-ai/dsh-api-workspace-files";
import { RemoteError, remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { scopeToSession } from "../src/workspace-files.js";

const HOST_CWD = "/home/host/.dsh/workspaces/repo";
const SANDBOX_ROOT = "/workspace/repository";

type Target = { readonly path: string };

/** The fake filesystem's targets carry only a path; the stock code never looks inside. */
const target = (path: string) => ({ path }) as unknown as FsTarget;

/**
 * Enough of `SandboxFileSystem` to exercise the service: every call needs an
 * initiating agent, like the real one, and the host session cwd maps onto the
 * sandbox workspace, like `pathInSandbox` does.
 */
function makeFakeFs(
  agents: { requireInitiator: () => Agent },
  files: Map<string, string>,
) {
  const initiators: Agent[] = [];
  const observe = () => {
    initiators.push(agents.requireInitiator());
  };
  const directories = new Set<string>([SANDBOX_ROOT]);
  for (const file of files.keys()) {
    let parent = file;
    while (parent !== "/" && parent !== SANDBOX_ROOT) {
      parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
      directories.add(parent);
    }
  }
  const translate = (path: string) =>
    path === HOST_CWD || path.startsWith(`${HOST_CWD}/`)
      ? `${SANDBOX_ROOT}${path.slice(HOST_CWD.length)}`
      : path;
  const absolute = (path: string, cwd: string) =>
    posix.normalize(
      path.startsWith("/") ? translate(path) : `${translate(cwd)}/${path}`,
    );
  const typeOf = (path: string) =>
    files.has(path) ? "file" : directories.has(path) ? "directory" : undefined;
  const fs = {
    resolve: async (path: string, options: { cwd?: string }) => {
      observe();
      return { path: absolute(path, options.cwd ?? SANDBOX_ROOT) };
    },
    lstat: async (path: string, options: { cwd: string }) => {
      observe();
      const type = typeOf(absolute(path, options.cwd));
      return type === undefined ? undefined : { type };
    },
    stat: async (target: Target) => {
      observe();
      const type = typeOf(target.path);
      if (type === undefined) {
        return undefined;
      }
      const size = files.get(target.path)?.length;
      return { type, version: `v-${target.path}`, size };
    },
    listDir: async (target: Target) => {
      observe();
      const prefix = `${target.path}/`;
      const names = new Set<string>();
      for (const path of [...files.keys(), ...directories]) {
        if (path.startsWith(prefix)) {
          names.add(path.slice(prefix.length).split("/")[0] ?? "");
        }
      }
      return [...names].sort().map((name) => {
        const path = `${prefix}${name}`;
        return {
          name,
          type: typeOf(path) ?? "other",
          size: files.get(path)?.length,
        };
      });
    },
    readByteRange: async (
      target: Target,
      range: { offset: number; length: number },
    ) => {
      observe();
      return new TextEncoder()
        .encode(files.get(target.path) ?? "")
        .slice(range.offset, range.offset + range.length);
    },
    streamText: async (target: Target) => {
      observe();
      const text = files.get(target.path) ?? "";
      return (async function* () {
        yield text;
      })();
    },
    contains: (root: Target, target: Target) => {
      observe();
      return (
        target.path === root.path || target.path.startsWith(`${root.path}/`)
      );
    },
    processPath: (target: Target) => {
      observe();
      return target.path;
    },
    fileUrl: (target: Target) => {
      observe();
      return pathToFileURL(target.path).href;
    },
  };
  return { fs, initiators };
}

function makeService(files: Map<string, string>) {
  const ctx = new Context();
  const agent = { id: "agent-one" } as unknown as Agent;
  const storage = new AsyncLocalStorage<Agent>();
  const agents = {
    requireInitiator: () => {
      const current = storage.getStore();
      if (current === undefined) {
        throw new Error("no initiating Agent");
      }
      return current;
    },
    withInitiator: <T>(initiator: Agent, operation: () => T): T =>
      storage.run(initiator, operation),
  };
  const resolveCalls: string[] = [];
  const sessionController = {
    resolveAgent: async (sessionId: SessionId) => {
      resolveCalls.push(sessionId);
      if (sessionId === ("session-one" as SessionId)) {
        return { agent };
      }
      return {
        error: new RemoteError(
          "session/not-found",
          `Session ${sessionId} not found`,
          { sessionId },
        ),
      };
    },
  };
  const { fs, initiators } = makeFakeFs(agents, files);
  ctx.provide("fs", fs);
  ctx.provide("sandboxPolicy", { workspaceRoot: SANDBOX_ROOT });
  // The stock constructor waits for `sessions` and `typert` before it
  // registers its lookup; neither exists here, so the methods stand alone.
  const service = new WorkspaceFiles(ctx, {
    maxBytes: 1024,
    maxFileBytes: 1024,
    maxLines: 100,
    maxEntries: 50,
  });
  const undo = scopeToSession(service, agents, sessionController);
  const scope: WorkspaceFileScope = {
    sessionId: "session-one" as SessionId,
    workspaceRoot: HOST_CWD,
  };
  return { ctx, service, undo, agent, scope, initiators, resolveCalls };
}

function signal() {
  return new AbortController().signal;
}

describe("scopeToSession", () => {
  it("lists the session cwd as its sandbox directory, acting as the session agent", async () => {
    const { service, scope, agent, initiators, resolveCalls } = makeService(
      new Map([
        [`${SANDBOX_ROOT}/README.md`, "# hi\n"],
        [`${SANDBOX_ROOT}/src/index.ts`, "export {};\n"],
      ]),
    );

    const listing = await service.list(scope, ".", signal());

    expect(listing).toEqual({
      path: "",
      entries: [
        { name: "README.md", type: "file", size: 5 },
        { name: "src", type: "directory" },
      ],
      truncated: false,
    });
    expect(resolveCalls).toEqual(["session-one"]);
    expect(initiators.length).toBeGreaterThan(0);
    expect(initiators.every((seen) => seen === agent)).toBe(true);
  });

  it("reads a page of a file and reports its sandbox path", async () => {
    const { service, scope } = makeService(
      new Map([[`${SANDBOX_ROOT}/notes.txt`, "one\ntwo\nthree\n"]]),
    );

    const page = await service.read(
      scope,
      "notes.txt",
      { offset: 2, limit: 1 },
      signal(),
    );

    expect(page).toMatchObject({
      offset: 2,
      text: "two",
      lines: 1,
      eof: false,
      absolutePath: `${SANDBOX_ROOT}/notes.txt`,
    });
  });

  it("refuses a session the controller cannot resolve with its own error", async () => {
    const { service, initiators } = makeService(new Map());
    const unknown: WorkspaceFileScope = {
      sessionId: "session-gone" as SessionId,
      workspaceRoot: HOST_CWD,
    };

    const failure = await service
      .stat(unknown, "README.md", signal())
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RemoteError);
    expect((failure as RemoteError).code).toBe("session/not-found");
    expect(initiators).toEqual([]);
  });

  it("follows filesystem observations inside the workspace as the session agent", async () => {
    const { ctx, service, scope, agent, initiators } = makeService(new Map());
    const controller = new AbortController();
    const changes = service.changes(scope, controller.signal);
    const frames = changes[Symbol.asyncIterator]();

    const ready = await frames.next();
    expect(ready).toEqual({ done: false, value: { kind: "ready" } });
    expect(initiators).toEqual([agent]);

    ctx.emit(
      "fs/observed",
      target("/elsewhere/secret.txt"),
      { kind: "present", version: "1" as FsVersion },
      undefined,
    );
    ctx.emit(
      "fs/observed",
      target(`${SANDBOX_ROOT}/out.txt`),
      { kind: "present", version: "7" as FsVersion },
      undefined,
    );
    const change = await frames.next();
    expect(change).toEqual({
      done: false,
      value: {
        kind: "change",
        change: { absolutePath: `${SANDBOX_ROOT}/out.txt`, version: "7" },
      },
    });
    expect(initiators.every((seen) => seen === agent)).toBe(true);

    controller.abort();
    await expect(frames.next()).resolves.toMatchObject({ done: true });
  });

  it("leaves the stock prototype and its remote markers alone, and undoes cleanly", async () => {
    const { service, undo, scope } = makeService(new Map());

    const wrapped = [
      "read",
      "readBytes",
      "readAll",
      "readRelated",
      "stat",
      "list",
      "changes",
    ];
    for (const method of wrapped) {
      expect(Object.hasOwn(service, method)).toBe(true);
    }
    // The gateway reads remote markers and, without a manifest, parameter
    // names from the stock methods; both live on the prototype and stay there.
    const methods = remoteMethods(service)
      .map((marker) => marker.method)
      .sort();
    expect(methods).toEqual([...wrapped].sort());
    const source = Function.prototype.toString.call(
      Object.getOwnPropertyDescriptor(WorkspaceFiles.prototype, "read")?.value,
    );
    expect(source.slice(source.indexOf("(") + 1, source.indexOf(")"))).toBe(
      "workspaceFileScope, path, range, signal",
    );

    undo();
    for (const method of wrapped) {
      expect(Object.hasOwn(service, method)).toBe(false);
    }
    // Back to the stock behaviour: no initiator, so the filesystem refuses.
    await expect(service.stat(scope, "README.md", signal())).rejects.toThrow(
      "no initiating Agent",
    );
  });
});
