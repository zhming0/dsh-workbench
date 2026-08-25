import { generateKeyPair, type KeyObject } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { importPKCS8, SignJWT } from "jose";

import type { RunnerAuth } from "./types.js";

const generate = promisify(generateKeyPair);

export class ProviderKeyStore implements RunnerAuth {
  private privateKey?: CryptoKey;
  private publicPem?: string;

  constructor(private readonly privateKeyPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.privateKeyPath), { recursive: true, mode: 0o700 });
    let privatePem: string;
    try {
      privatePem = await readFile(this.privateKeyPath, "utf8");
      this.publicPem = await readFile(`${this.privateKeyPath}.pub`, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const pair = await generate("ed25519");
      privatePem = exportPem(pair.privateKey, "private");
      this.publicPem = exportPem(pair.publicKey, "public");
      await writePrivateFile(this.privateKeyPath, privatePem);
      await writePrivateFile(
        `${this.privateKeyPath}.pub`,
        this.publicPem,
        0o644,
      );
    }
    this.privateKey = await importPKCS8(privatePem, "EdDSA");
  }

  get publicKeyPem(): string {
    if (this.publicPem === undefined)
      throw new Error("provider signing key is not ready");
    return this.publicPem;
  }

  async createToken(sandboxId: string): Promise<string> {
    if (this.privateKey === undefined)
      throw new Error("provider signing key is not ready");
    return new SignJWT({ sandbox_id: sandboxId })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("3m")
      .setSubject("dsh-sandbox-provider")
      .sign(this.privateKey);
  }
}

function exportPem(key: KeyObject, kind: "private" | "public"): string {
  return key
    .export(
      kind === "private"
        ? { type: "pkcs8", format: "pem" }
        : { type: "spki", format: "pem" },
    )
    .toString();
}

async function writePrivateFile(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
