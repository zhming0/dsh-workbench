import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CredentialBroker,
  normalizeRepositoryUrl,
  testing as brokerTesting,
} from "../src/broker.js";

describe("credential broker", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("stores secret names without exposing values in listings", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();
    await broker.setSecret("API_KEY", "secret-value");
    expect(broker.secretNames()).toEqual(["API_KEY"]);
    expect(broker.secrets()).toEqual({ API_KEY: "secret-value" });
    await expect(broker.setSecret("not-valid-name", "x")).rejects.toThrow(
      "invalid",
    );
  });

  it("serves a GITHUB_TOKEN secret as the github.com git credential", async () => {
    const broker = new CredentialBroker({
      path: join(directory, "broker.json"),
    });
    await broker.initialize();

    // No GITHUB_TOKEN secret: no credential.
    expect(
      await broker.gitCredentials("https://github.com/example/repo.git"),
    ).toEqual([]);

    await broker.setSecret("GITHUB_TOKEN", "pat-value");
    expect(
      await broker.gitCredentials("https://github.com/example/repo.git"),
    ).toEqual([
      {
        host: "github.com",
        username: "x-access-token",
        password: "pat-value",
      },
    ]);

    // Only github.com is mapped.
    expect(
      await broker.gitCredentials("https://gitlab.com/example/repo.git"),
    ).toEqual([]);
  });

  it("parses repository hosts and normalizes clone URLs", () => {
    expect(
      brokerTesting.repositoryHost("git@github.com:example/repo.git"),
    ).toBe("github.com");
    expect(
      brokerTesting.repositoryHost("https://gitlab.com/example/repo.git"),
    ).toBe("gitlab.com");
    expect(normalizeRepositoryUrl("git@github.com:example/repo.git")).toBe(
      "https://github.com/example/repo.git",
    );
  });
});
