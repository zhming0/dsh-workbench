#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="dsh-kas"

usage() { echo "Usage: teardown.sh [--name NAME]"; }
while (($#)); do
  case "$1" in
    --name) [[ $# -ge 2 ]] || { echo "error: --name needs a value" >&2; exit 2; }; CLUSTER_NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
command -v kind >/dev/null || { echo "error: required command not found: kind" >&2; exit 1; }
if kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  kind delete cluster --name "$CLUSTER_NAME"
else
  echo "kind cluster '$CLUSTER_NAME' does not exist; nothing to do"
fi
