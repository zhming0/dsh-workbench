#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";

import { CredentialBroker } from "./broker.js";
import { ProviderKeyStore } from "./key-store.js";

const stateDir =
  process.env.DSH_SANDBOX_STATE_DIR ?? join(homedir(), ".dsh-sandbox");

async function main(arguments_: string[]): Promise<void> {
  const [command, subcommand, name] = arguments_;
  if (command === "auth" && subcommand === "github") {
    const broker = await openBroker();
    await broker.authorizeGitHub((challenge) => {
      process.stdout.write(
        `Open ${challenge.verificationUri} and enter code ${challenge.userCode}.\nWaiting for approval…\n`,
      );
    });
    process.stdout.write(
      "GitHub authorization saved in the provider's local store.\n",
    );
    return;
  }

  if (command === "secret" && subcommand === "list") {
    const broker = await openBroker();
    for (const secretName of broker.secretNames())
      process.stdout.write(`${secretName}\n`);
    return;
  }

  if (command === "secret" && subcommand === "set" && name !== undefined) {
    if (process.stdin.isTTY)
      throw new Error("pipe the secret value on standard input");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    const broker = await openBroker();
    await broker.setSecret(name, value);
    process.stdout.write(`Stored ${name}.\n`);
    return;
  }

  if (command === "secret" && subcommand === "delete" && name !== undefined) {
    const broker = await openBroker();
    await broker.deleteSecret(name);
    process.stdout.write(`Deleted ${name}.\n`);
    return;
  }

  if (command === "key" && subcommand === "public") {
    const keys = new ProviderKeyStore(join(stateDir, "provider-key.pem"));
    await keys.initialize();
    process.stdout.write(keys.publicKeyPem);
    return;
  }

  process.stdout.write(`Usage:
  dsh-sandbox auth github
  dsh-sandbox secret list
  printf '%s' VALUE | dsh-sandbox secret set NAME
  dsh-sandbox secret delete NAME
  dsh-sandbox key public
`);
  if (command !== undefined) process.exitCode = 2;
}

async function openBroker(): Promise<CredentialBroker> {
  const clientId = process.env.DSH_SANDBOX_GITHUB_CLIENT_ID;
  const broker = new CredentialBroker({
    path: join(stateDir, "broker.json"),
    ...(clientId === undefined ? {} : { githubClientId: clientId }),
  });
  await broker.initialize();
  return broker;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`dsh-sandbox: ${String(error)}\n`);
  process.exitCode = 1;
});
