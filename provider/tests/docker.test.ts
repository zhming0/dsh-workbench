import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DockerBackend,
  testing as dockerTesting,
} from "../src/backends/docker.js";

describe("docker backend", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dsh-sandbox-provider-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("derives stable sandbox names and parses docker inspect output", () => {
    expect(dockerTesting.sandboxName("session one")).toMatch(
      /^dsh-[a-f0-9]{16}$/,
    );
    expect(
      dockerTesting.parseInspect(
        JSON.stringify([
          {
            Id: "container-one",
            Config: { Labels: { "dsh.session": "session one" } },
            State: { Status: "exited" },
          },
        ]),
      ),
    ).toEqual({
      containerId: "container-one",
      sessionId: "session one",
      status: "exited",
    });
  });

  it("recovers a Docker container created before its session was saved", async () => {
    const commandLog = join(directory, "docker-commands.jsonl");
    const docker = join(directory, "fake-docker.mjs");
    await writeFile(
      docker,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "run") process.exit(1);
if (args[0] === "inspect") process.stdout.write(JSON.stringify([{
  Id: "existing-container",
  Config: { Labels: { "dsh.session": "session-one" } },
  State: { Status: "exited" }
}]));
`,
      { mode: 0o700 },
    );
    const backend = new DockerBackend({
      image: "runner:large",
      binary: docker,
      hostUrl: "tcp://host.docker.internal:8081",
      registrationToken: "token-value",
    });

    const handle = await backend.provision({
      sessionId: "session-one",
      repositoryUrl: "https://github.com/example/repo.git",
    });

    expect(handle).toEqual({
      sandboxId: dockerTesting.sandboxName("session-one"),
      reference: {
        containerId: "existing-container",
        sandboxId: dockerTesting.sandboxName("session-one"),
      },
    });
    const commands = (await readFile(commandLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands.map(([command]) => command)).toEqual([
      "run",
      "inspect",
      "start",
    ]);
    expect(commands[0]).toContain("HOST_URL=tcp://host.docker.internal:8081");
    expect(commands[0]).toContain("REGISTRATION_TOKEN=token-value");
    expect(commands[0]?.at(-1)).toBe("runner:large");
    expect(commands[2]).toEqual(["start", "existing-container"]);
  });
});
