import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BuildkiteBackend,
  testing as buildkiteTesting,
} from "../src/backends/buildkite.js";
import { resolveConfig } from "../src/config.js";
import { testing as managerTesting } from "../src/manager.js";
import { DEFAULT_RUNNER_IMAGE } from "../src/runner-image.js";
import { SandboxNotFoundError } from "../src/types.js";

const PIPELINE_URL =
  "https://api.buildkite.com/v2/organizations/acme/pipelines/dsh-sandbox";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fake Buildkite API: each request pops the next scripted response. */
function fakeApi(responses: Array<{ status?: number; body?: unknown }>): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: init?.headers as Record<string, string>,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as unknown }
        : {}),
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`unexpected request ${init?.method} ${url}`);
    }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch: fetchImpl };
}

function backendWith(api: { fetch: typeof fetch }): BuildkiteBackend {
  return new BuildkiteBackend(
    {
      organization: "acme",
      pipeline: "dsh-sandbox",
      image: "ghcr.io/zhming0/dsh-runner:test",
      branch: "main",
      hostUrl: "tls://dsh.example.com:8081",
      readyTimeoutMs: 60_000,
      token: "bkua_test",
    },
    api.fetch,
  );
}

describe("Buildkite backend", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates one build per sandbox and waits for its job to start", async () => {
    vi.useFakeTimers();
    const api = fakeApi([
      { body: [] },
      { body: { number: 7, state: "scheduled", web_url: "https://bk/7" } },
      { body: { number: 7, state: "scheduled", web_url: "https://bk/7" } },
      { body: { number: 7, state: "running", web_url: "https://bk/7" } },
    ]);
    const backend = backendWith(api);

    const pending = backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const handle = await pending;

    expect(handle.sandboxId).toMatch(/^dsh-[0-9a-f]{16}-[0-9a-f]{6}$/);
    expect(handle.reference).toEqual({
      buildNumber: 7,
      sandboxId: handle.sandboxId,
    });

    const [lookup, create, ...polls] = api.calls;
    expect(lookup?.method).toBe("GET");
    expect(lookup?.url).toBe(
      `${PIPELINE_URL}/builds?${new URLSearchParams([
        ["meta_data[dsh-session]", "session-one"],
        ["exclude_pipeline", "true"],
        ["exclude_jobs", "true"],
        ["state[]", "scheduled"],
        ["state[]", "running"],
      ])}`,
    );
    expect(create?.method).toBe("POST");
    expect(create?.url).toBe(`${PIPELINE_URL}/builds`);
    expect(create?.headers.authorization).toBe("Bearer bkua_test");
    expect(create?.body).toEqual({
      commit: "HEAD",
      branch: "main",
      message: `dsh sandbox ${handle.sandboxId}`,
      env: {
        SANDBOX_ID: handle.sandboxId,
        HOST_URL: "tls://dsh.example.com:8081",
        DSH_RUNNER_IMAGE: "ghcr.io/zhming0/dsh-runner:test",
      },
      meta_data: { "dsh-session": "session-one" },
    });
    expect(polls.map((call) => call.url)).toEqual([
      `${PIPELINE_URL}/builds/7?exclude_jobs=true&exclude_pipeline=true`,
      `${PIPELINE_URL}/builds/7?exclude_jobs=true&exclude_pipeline=true`,
    ]);
  });

  it("adopts a live build created before the session was saved", async () => {
    const api = fakeApi([
      {
        body: [
          {
            number: 3,
            state: "running",
            web_url: "https://bk/3",
            env: { SANDBOX_ID: "dsh-existing", HOST_URL: "tls://x" },
          },
        ],
      },
    ]);

    const handle = await backendWith(api).provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });

    expect(handle).toEqual({
      sandboxId: "dsh-existing",
      reference: { buildNumber: 3, sandboxId: "dsh-existing" },
    });
    expect(api.calls).toHaveLength(1);
  });

  it("cancels a build whose job never started", async () => {
    vi.useFakeTimers();
    const api = fakeApi([
      { body: [] },
      { body: { number: 9, state: "scheduled", web_url: "https://bk/9" } },
      { body: { number: 9, state: "scheduled", web_url: "https://bk/9" } },
      { status: 200, body: { number: 9, state: "canceling" } },
    ]);
    const backend = new BuildkiteBackend(
      {
        organization: "acme",
        pipeline: "dsh-sandbox",
        image: "ghcr.io/zhming0/dsh-runner:test",
        branch: "main",
        hostUrl: "tls://dsh.example.com:8081",
        readyTimeoutMs: 2_000,
        token: "bkua_test",
      },
      api.fetch,
    );

    const pending = backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });
    // Attach the handler before advancing so the rejection is never unhandled.
    const outcome = pending.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await outcome).toBe(
      "Buildkite build https://bk/9 did not start within 2000ms",
    );
    expect(api.calls.at(-1)).toMatchObject({
      method: "PUT",
      url: `${PIPELINE_URL}/builds/9/cancel`,
    });
  });

  it("reports a finished or missing build as lost so the manager replaces it", async () => {
    const finished = fakeApi([
      { body: { number: 4, state: "canceled", web_url: "https://bk/4" } },
    ]);
    await expect(
      backendWith(finished).wake({ buildNumber: 4, sandboxId: "dsh-a" }),
    ).rejects.toBeInstanceOf(SandboxNotFoundError);

    const missing = fakeApi([{ status: 404, body: { message: "Not Found" } }]);
    await expect(
      backendWith(missing).wake({ buildNumber: 5, sandboxId: "dsh-b" }),
    ).rejects.toBeInstanceOf(SandboxNotFoundError);

    const running = fakeApi([
      { body: { number: 6, state: "running", web_url: "https://bk/6" } },
    ]);
    expect(
      await backendWith(running).wake({ buildNumber: 6, sandboxId: "dsh-c" }),
    ).toEqual({
      sandboxId: "dsh-c",
      reference: { buildNumber: 6, sandboxId: "dsh-c" },
    });
  });

  it("treats only a running build as healthy and tolerates cancelling twice", async () => {
    const api = fakeApi([
      { body: { number: 8, state: "running", web_url: "https://bk/8" } },
      { body: { number: 8, state: "passed", web_url: "https://bk/8" } },
      { status: 422, body: { message: "Build is already finished" } },
      { status: 500, body: { message: "boom" } },
    ]);
    const backend = backendWith(api);
    const reference = { buildNumber: 8, sandboxId: "dsh-d" };

    expect(await backend.health(reference)).toBe(true);
    expect(await backend.health(reference)).toBe(false);
    await expect(backend.destroy(reference)).resolves.toBeUndefined();
    await expect(backend.destroy(reference)).rejects.toThrow("failed with 500");
    await expect(backend.hibernate()).rejects.toThrow("cannot be suspended");
  });

  it("derives a sandbox id from the session with a per-build suffix", () => {
    const first = buildkiteTesting.sandboxName("session-one");
    const second = buildkiteTesting.sandboxName("session-one");
    expect(first.slice(0, 21)).toBe(second.slice(0, 21));
    expect(first).not.toBe(second);
    expect(() =>
      buildkiteTesting.buildkiteReference({ claimName: "x" }),
    ).toThrow("invalid Buildkite sandbox reference");
  });

  it("resolves a Buildkite profile and requires its token at boot", () => {
    const config = resolveConfig({
      profiles: {
        hosted: {
          backend: "buildkite",
          organization: "acme",
          pipeline: "dsh-sandbox",
          hostUrl: "tls://dsh.example.com:8081",
        },
      },
    });
    expect(config.profiles).toEqual({
      hosted: {
        name: "hosted",
        backend: "buildkite",
        organization: "acme",
        pipeline: "dsh-sandbox",
        image: DEFAULT_RUNNER_IMAGE,
        branch: "main",
        hostUrl: "tls://dsh.example.com:8081",
        readyTimeoutMs: 600_000,
        tokenEnv: "BUILDKITE_API_TOKEN",
      },
    });

    vi.stubEnv("DSH_TEST_BUILDKITE_TOKEN", "");
    const hosted = config.profiles.hosted;
    if (hosted?.backend !== "buildkite") {
      throw new Error("expected a Buildkite profile");
    }
    const profile = { ...hosted, tokenEnv: "DSH_TEST_BUILDKITE_TOKEN" };
    expect(() =>
      managerTesting.createBackend(profile, "registration-token"),
    ).toThrow("needs a Buildkite API token in DSH_TEST_BUILDKITE_TOKEN");

    vi.stubEnv("DSH_TEST_BUILDKITE_TOKEN", "bkua_test");
    const backend = managerTesting.createBackend(profile, "registration-token");
    expect(backend).toBeInstanceOf(BuildkiteBackend);
    expect(backend.capabilities).toEqual({ supportsHibernate: false });
    vi.unstubAllEnvs();
  });
});
