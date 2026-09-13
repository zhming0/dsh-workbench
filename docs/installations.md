# Installation

Two install phases, then a follow-up:

| Step | What it is | Page |
| ---- | ---------- | ---- |
| 1 | **Control plane** — the `dsh-workbench` Helm chart: host, data volume, tunnel Service, registration token, the host's Kubernetes API access, and the credentials the host itself needs | [installations-control-plane.md](installations-control-plane.md) |
| 2 | **Runner** — where sessions actually run | [Kubernetes agent-sandbox](installations-kas.md) or [Buildkite agent](installations-buildkite.md) |
| 3 | **Sandbox credentials** — the secrets sessions receive | [credentials.md](credentials.md) |

The phases are independent. After step 1 the Web UI, sessions, secrets,
instructions, and repository workspaces all work; the first tool call fails
with a message naming the missing runner until step 2 is done.

Docker and checkout installs are development paths, not the product:
[`development.md`](development.md).
