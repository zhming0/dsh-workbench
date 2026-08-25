import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AuthChallenge, ChallengeHandler } from "./types.js";

interface BrokerFile {
  version: 1;
  secrets: Record<string, string>;
  githubToken?: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export interface BrokerOptions {
  path: string;
  githubClientId?: string;
}

/** Durable authority stays on the host; only current values are pushed to a runner. */
export class CredentialBroker {
  private state: BrokerFile = { version: 1, secrets: {} };
  private authorization: Promise<string> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrokerOptions) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    await this.refresh();
  }

  /** Pick up changes made by the companion CLI before the next command runs. */
  async refresh(): Promise<void> {
    if (this.authorization !== undefined) return;
    await this.writeChain;
    try {
      this.state = parseBrokerFile(
        JSON.parse(await readFile(this.options.path, "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) this.state = { version: 1, secrets: {} };
      else throw error;
    }
  }

  secrets(): Record<string, string> {
    return { ...this.state.secrets };
  }

  secretNames(): string[] {
    return Object.keys(this.state.secrets).sort();
  }

  async setSecret(name: string, value: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid environment variable name: ${name}`);
    }
    this.state.secrets[name] = value;
    await this.persist();
  }

  async deleteSecret(name: string): Promise<void> {
    delete this.state.secrets[name];
    await this.persist();
  }

  async gitCredentials(
    repositoryUrl: string,
    onChallenge?: ChallengeHandler,
  ): Promise<Array<{ host: string; username: string; password: string }>> {
    const host = repositoryHost(repositoryUrl);
    if (host !== "github.com") return [];
    if (this.state.githubToken === undefined) {
      if (this.options.githubClientId === undefined) return [];
      await this.authorizeGitHub(onChallenge);
    }
    return [
      { host, username: "x-access-token", password: this.state.githubToken! },
    ];
  }

  async authorizeGitHub(onChallenge?: ChallengeHandler): Promise<string> {
    if (this.state.githubToken !== undefined) return this.state.githubToken;
    this.authorization ??= this.runDeviceFlow(onChallenge).finally(() => {
      this.authorization = undefined;
    });
    return this.authorization;
  }

  private async runDeviceFlow(onChallenge?: ChallengeHandler): Promise<string> {
    const clientId = this.options.githubClientId;
    if (clientId === undefined) {
      throw new Error(
        "GitHub authentication needs githubClientId in provider configuration",
      );
    }

    const device = await postForm<DeviceCodeResponse>(
      "https://github.com/login/device/code",
      new URLSearchParams({ client_id: clientId, scope: "repo read:user" }),
    );
    const challenge: AuthChallenge = {
      verificationUri: device.verification_uri,
      userCode: device.user_code,
      expiresInSeconds: device.expires_in,
    };
    onChallenge?.(challenge);

    const deadline = Date.now() + device.expires_in * 1_000;
    let intervalMs = Math.max(device.interval, 5) * 1_000;
    while (Date.now() < deadline) {
      await delay(intervalMs);
      const token = await postForm<TokenResponse>(
        "https://github.com/login/oauth/access_token",
        new URLSearchParams({
          client_id: clientId,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      );
      if (token.access_token !== undefined) {
        this.state.githubToken = token.access_token;
        await this.persist();
        return token.access_token;
      }
      if (token.error === "authorization_pending") continue;
      if (token.error === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      throw new Error(
        token.error_description ?? token.error ?? "GitHub device flow failed",
      );
    }
    throw new Error(
      "GitHub device code expired before authorization completed",
    );
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.options.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.options.path);
    });
    return this.writeChain;
  }
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok)
    throw new Error(`GitHub authentication returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

function repositoryHost(url: string): string | undefined {
  const scpStyle = /^[^@]+@([^:]+):/.exec(url);
  if (scpStyle?.[1] !== undefined) return scpStyle[1].toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function normalizeRepositoryUrl(url: string): string {
  const scpStyle = /^git@github\.com:(.+)$/.exec(url);
  if (scpStyle?.[1] !== undefined) return `https://github.com/${scpStyle[1]}`;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "ssh:" &&
      parsed.hostname.toLowerCase() === "github.com"
    ) {
      return `https://github.com/${parsed.pathname.replace(/^\//, "")}`;
    }
  } catch {
    // Keep local paths and other Git URL forms unchanged.
  }
  return url;
}

function parseBrokerFile(value: unknown): BrokerFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("secrets" in value) ||
    typeof value.secrets !== "object" ||
    value.secrets === null
  ) {
    throw new Error("credential broker file has an unsupported format");
  }
  return value as BrokerFile;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const testing = { repositoryHost };
