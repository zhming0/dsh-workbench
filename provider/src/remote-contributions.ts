import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry/types";
import type { TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

import type { SandboxInstructionsRemote } from "./instructions-remote.js";
import { sandboxInstructionsDescriptors } from "./instructions-remote.js";
import type { RepositoryWorkspaceRemote } from "./repository-workspace-remote.js";
import { repositoryWorkspaceDescriptors } from "./repository-workspace-remote.js";
import type { SandboxSecretsRemote } from "./secrets-remote.js";
import { sandboxSecretsDescriptors } from "./secrets-remote.js";
import type { SessionProfileRemote } from "./session-profile-remote.js";
import { sessionProfileDescriptors } from "./session-profile-remote.js";

/** Everything the sandboxManager service exposes to the browser. */
type SandboxManagerRemote = RepositoryWorkspaceRemote &
  SandboxSecretsRemote &
  SandboxInstructionsRemote &
  SessionProfileRemote;

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    sandboxManager: SandboxManagerRemote;
  }

  interface TypertRemoteMap {
    "sandboxManager/createRepositoryWorkspace": SandboxManagerRemote["createRepositoryWorkspace"];
    "sandboxManager/listSecrets": SandboxManagerRemote["listSecrets"];
    "sandboxManager/setSecret": SandboxManagerRemote["setSecret"];
    "sandboxManager/deleteSecret": SandboxManagerRemote["deleteSecret"];
    "sandboxManager/getInstructions": SandboxManagerRemote["getInstructions"];
    "sandboxManager/setGlobalInstructions": SandboxManagerRemote["setGlobalInstructions"];
    "sandboxManager/setWorkspaceInstructions": SandboxManagerRemote["setWorkspaceInstructions"];
    "sandboxManager/getSessionProfile": SandboxManagerRemote["getSessionProfile"];
    "sandboxManager/setSessionProfile": SandboxManagerRemote["setSessionProfile"];
  }
}

// typert accepts one contribution per package face and one remote contribution
// per package, so every browser-facing invocation this package owns must be
// registered together.
const descriptors = [
  ...repositoryWorkspaceDescriptors,
  ...sandboxSecretsDescriptors,
  ...sandboxInstructionsDescriptors,
  ...sessionProfileDescriptors,
];

export const workbenchHost: TypertContribution = {
  package: "@zhming0/dsh-workbench",
  face: "host",
  schemas: [],
  invocations: descriptors,
  model: { services: [], events: [], objects: [] },
};

export const workbenchRemote: TypertRemoteContribution = {
  package: "@zhming0/dsh-workbench",
  descriptors,
};
