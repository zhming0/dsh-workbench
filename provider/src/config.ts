import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";

import { DEFAULT_RUNNER_IMAGE } from "./runner-image.js";
import type { SandboxProfile } from "./types.js";

/** A profile as written in the settings file: a backend plus its settings. */
export type ProfileConfig =
  | {
      backend: "docker";
      image?: string;
      binary?: string;
      hostUrl?: string;
    }
  | {
      backend: "kas";
      namespace?: string;
      warmPool?: string;
      readyTimeoutMs?: number;
      kubeconfig?: string;
    };

export interface Config {
  /** Named sandbox profiles a session can choose from before its first prompt. */
  profiles: Record<string, ProfileConfig>;
  /** Profile used when the session did not pick one. Defaults to the first. */
  defaultProfile?: string;
  stateDir?: string;
  repository?: string;
  revision?: string;
  workspace?: string;
  idleMs?: number;
  expiresAfterMs?: number;
  registrationToken?: string;
  tunnel?: {
    port?: number;
    bind?: string;
  };
}

export interface ResolvedConfig {
  profiles: Record<string, SandboxProfile>;
  defaultProfile: string;
  stateDir: string;
  repository?: string;
  revision: string;
  workspace: string;
  idleMs: number;
  expiresAfterMs: number;
  registrationToken?: string;
  tunnel: { port: number; bind: string };
}

/**
 * The schema cordis validates the row config against. Every default here must
 * stay in sync with resolveConfig, which applies the same defaults at runtime.
 */
export const configSchema: Schemastery<Config> = z.object({
  profiles: z
    .dict(
      z.union([
        z.object({
          backend: z.const("docker").required(),
          image: z.string().default(DEFAULT_RUNNER_IMAGE),
          binary: z.string(),
          hostUrl: z.string(),
        }),
        z.object({
          backend: z.const("kas").required(),
          namespace: z.string().default("dsh-sandbox"),
          warmPool: z.string().default("dsh-universal"),
          readyTimeoutMs: z.number().min(1).default(180_000),
          kubeconfig: z.string(),
        }),
      ]),
    )
    .required(),
  defaultProfile: z.string(),
  stateDir: z.string(),
  repository: z.string(),
  revision: z.string().default(""),
  workspace: z.string().default("/workspace/repository"),
  idleMs: z
    .number()
    .min(1)
    .default(10 * 60_000),
  expiresAfterMs: z
    .number()
    .min(1)
    .default(7 * 24 * 60 * 60_000),
  registrationToken: z.string(),
  tunnel: z.object({
    port: z.natural().min(1).max(65_535).default(8081),
    bind: z.string().default("0.0.0.0"),
  }),
});

/** Apply every default and check the settings hold together. */
export function resolveConfig(config: Config): ResolvedConfig {
  const stateDir = config.stateDir ?? join(homedir(), ".dsh-sandbox");
  const tunnelPort = config.tunnel?.port ?? 8081;
  const [firstProfile] = Object.keys(config.profiles);
  if (firstProfile === undefined) {
    throw new Error("sandbox-manager needs at least one profile");
  }
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, profile]) => [
      name,
      resolveProfile(name, profile, tunnelPort),
    ]),
  );
  const defaultProfile = config.defaultProfile ?? firstProfile;
  if (profiles[defaultProfile] === undefined) {
    throw new Error(
      `defaultProfile ${defaultProfile} is not a configured profile`,
    );
  }
  const resolved: ResolvedConfig = {
    profiles,
    defaultProfile,
    stateDir,
    ...(config.repository === undefined
      ? {}
      : { repository: config.repository }),
    revision: config.revision ?? "",
    workspace: config.workspace ?? "/workspace/repository",
    idleMs: config.idleMs ?? 10 * 60_000,
    expiresAfterMs: config.expiresAfterMs ?? 7 * 24 * 60 * 60_000,
    ...(config.registrationToken === undefined
      ? {}
      : { registrationToken: config.registrationToken }),
    tunnel: {
      port: tunnelPort,
      bind: config.tunnel?.bind ?? "0.0.0.0",
    },
  };
  for (const [name, value] of [
    ["idleMs", resolved.idleMs],
    ["expiresAfterMs", resolved.expiresAfterMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be positive`);
    }
  }
  if (!resolved.workspace.startsWith("/")) {
    throw new Error("workspace must be an absolute Linux path");
  }
  return resolved;
}

function resolveProfile(
  name: string,
  profile: ProfileConfig,
  tunnelPort: number,
): SandboxProfile {
  if (profile.backend === "docker") {
    return {
      name,
      backend: "docker",
      image: profile.image ?? DEFAULT_RUNNER_IMAGE,
      ...(profile.binary === undefined ? {} : { binary: profile.binary }),
      // host-gateway resolves the Docker host from inside a container on
      // every Docker platform, so runners reach the host tunnel by default.
      hostUrl: profile.hostUrl ?? `tcp://host.docker.internal:${tunnelPort}`,
    };
  }
  return {
    name,
    backend: "kas",
    namespace: profile.namespace ?? "dsh-sandbox",
    warmPool: profile.warmPool ?? "dsh-universal",
    readyTimeoutMs: profile.readyTimeoutMs ?? 180_000,
    ...(profile.kubeconfig === undefined
      ? {}
      : { kubeconfig: profile.kubeconfig }),
  };
}

const TOKEN_ENV = "DSH_WORKBENCH_REGISTRATION_TOKEN";

/**
 * The shared secret runners present when they dial the host tunnel. Accepts
 * a comma-separated list so a rotation can admit old and new tokens at once;
 * new sandboxes always receive the first entry.
 */
export function resolveRegistrationTokens(
  config: ResolvedConfig,
  profiles: SandboxProfile[],
): string[] {
  const configured = config.registrationToken ?? process.env[TOKEN_ENV];
  if (configured !== undefined) {
    const tokens = configured
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "");
    if (tokens.length === 0) {
      throw new Error("the configured registration token is empty");
    }
    return tokens;
  }
  const remote = profiles.find((profile) => profile.backend !== "docker");
  if (remote !== undefined) {
    throw new Error(
      `the ${remote.backend} backend needs a registration token; set ${TOKEN_ENV} or the registrationToken config`,
    );
  }
  // Docker development runs host and runners on one machine, so the provider
  // can mint its own token. Persisting it keeps sandboxes from an earlier
  // provider process registerable after a restart.
  const path = join(config.stateDir, "registration-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") {
      return [existing];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return [token];
}
