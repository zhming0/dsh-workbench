#!/usr/bin/env bash
set -euo pipefail

readonly KAS_VERSION="v0.5.4"
readonly INSTALL_URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${KAS_VERSION}/sandbox-with-extensions.yaml"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="dsh-kas"
RUNNER_IMAGE=""
HOST_IMAGE=""
HOST_URL=""
TOKEN_FILE=""
LOAD_IMAGE=false

usage() {
  cat <<'EOF'
Usage: dev-cluster.sh --runner-image IMAGE (--host-image IMAGE | --host-url URL)
                      [--registration-token-file FILE]
                      [--load-runner-image] [--name NAME]

Creates/reuses a kind cluster, installs agent-sandbox v0.5.4, and applies the
reference environment. --load-runner-image loads existing local Docker images
(the runner, and the host when --host-image is set) into kind.

With --host-image, the dsh host runs in-cluster and runners dial its
dsh-host-tunnel Service. With --host-url, dsh runs outside the cluster and
runners dial URL instead (tcp://... or tls://...; the address must be
reachable from pods, and the sandbox NetworkPolicy must be widened to it).

The registration token is read from FILE when given, otherwise generated.
Either way it lands in the dsh-registration-token Secret that both the host
and the warm runners read. With --host-url, pass the same token to the
external dsh host via DSH_WORKBENCH_REGISTRATION_TOKEN.
EOF
}

while (($#)); do
  case "$1" in
    --runner-image) [[ $# -ge 2 ]] || { echo "error: --runner-image needs a value" >&2; exit 2; }; RUNNER_IMAGE="$2"; shift 2 ;;
    --host-image) [[ $# -ge 2 ]] || { echo "error: --host-image needs a value" >&2; exit 2; }; HOST_IMAGE="$2"; shift 2 ;;
    --host-url) [[ $# -ge 2 ]] || { echo "error: --host-url needs a value" >&2; exit 2; }; HOST_URL="$2"; shift 2 ;;
    --registration-token-file) [[ $# -ge 2 ]] || { echo "error: --registration-token-file needs a value" >&2; exit 2; }; TOKEN_FILE="$2"; shift 2 ;;
    --load-runner-image) LOAD_IMAGE=true; shift ;;
    --name) [[ $# -ge 2 ]] || { echo "error: --name needs a value" >&2; exit 2; }; CLUSTER_NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for command in kind kubectl sed od; do
  command -v "$command" >/dev/null || { echo "error: required command not found: $command" >&2; exit 1; }
done
[[ -n "$RUNNER_IMAGE" ]] || { echo "error: --runner-image is required (the checked-in manifest intentionally has a placeholder)" >&2; exit 2; }
if [[ -n "$HOST_IMAGE" && -n "$HOST_URL" ]]; then
  echo "error: --host-image and --host-url conflict: pick in-cluster or external host" >&2; exit 2
fi
if [[ -z "$HOST_IMAGE" && -z "$HOST_URL" ]]; then
  echo "error: either --host-image or --host-url is required (runners must know where to dial)" >&2; exit 2
fi
if [[ -n "$TOKEN_FILE" ]]; then
  [[ -r "$TOKEN_FILE" ]] || { echo "error: cannot read token file: $TOKEN_FILE" >&2; exit 2; }
fi
kubectl version --client >/dev/null || { echo "error: kubectl is not usable" >&2; exit 1; }

if ! kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --wait 120s
fi
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null

if $LOAD_IMAGE; then
  command -v docker >/dev/null || { echo "error: Docker is required by --load-runner-image" >&2; exit 1; }
  for image in "$RUNNER_IMAGE" ${HOST_IMAGE:+"$HOST_IMAGE"}; do
    docker image inspect "$image" >/dev/null 2>&1 || { echo "error: local image not found: $image" >&2; exit 1; }
    kind load docker-image --name "$CLUSTER_NAME" "$image"
  done
fi

echo "Installing agent-sandbox ${KAS_VERSION}..."
kubectl apply -f "$INSTALL_URL"
for crd in sandboxes.agents.x-k8s.io sandboxclaims.extensions.agents.x-k8s.io sandboxtemplates.extensions.agents.x-k8s.io sandboxwarmpools.extensions.agents.x-k8s.io; do
  kubectl wait --for=condition=Established "crd/$crd" --timeout=120s
done
kubectl -n agent-sandbox-system wait --for=condition=Available deployment --all --timeout=180s

kubectl apply -f "$ROOT_DIR/deploy/kubernetes/00-namespace.yaml"
kubectl -n dsh-sandbox delete sandboxwarmpool dsh-universal --ignore-not-found --wait=true
kubectl apply -f "$ROOT_DIR/deploy/kubernetes/40-provider-rbac.yaml"

# The registration Secret must exist before host and warm pods start; both
# read it. Never echo the token.
if [[ -n "$TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
  [[ -n "$TOKEN" ]] || { echo "error: token file is empty" >&2; exit 2; }
else
  TOKEN="$(od -vN 32 -An -tx1 /dev/urandom | tr -d ' \n')"
fi
kubectl -n dsh-sandbox create secret generic dsh-registration-token \
  --from-literal="token=$TOKEN" \
  --dry-run=client -o yaml \
  | kubectl apply -f -
unset TOKEN

if [[ -n "$HOST_IMAGE" ]]; then
  sed "s|DSH_HOST_IMAGE_PLACEHOLDER|${HOST_IMAGE//&/\\&}|g" \
    "$ROOT_DIR/deploy/kubernetes/50-host.yaml" \
    | kubectl apply -f -
  kubectl -n dsh-sandbox rollout status deployment/dsh-host --timeout=300s
fi

TEMPLATE="$(sed "s|DSH_RUNNER_IMAGE_PLACEHOLDER|${RUNNER_IMAGE//&/\\&}|g" \
  "$ROOT_DIR/deploy/kubernetes/20-sandbox-template.yaml")"
if [[ -n "$HOST_URL" ]]; then
  TEMPLATE="$(sed "s|tcp://dsh-host-tunnel.dsh-sandbox.svc.cluster.local:8081|${HOST_URL//&/\\&}|g" <<<"$TEMPLATE")"
fi
kubectl apply -f - <<<"$TEMPLATE"
kubectl apply -f "$ROOT_DIR/deploy/kubernetes/30-warm-pool.yaml"

echo "Waiting for warm capacity..."
kubectl -n dsh-sandbox wait --for=jsonpath='{.status.readyReplicas}'=1 sandboxwarmpool/dsh-universal --timeout=300s
echo "Ready. Run: scripts/kas/smoke-test.sh --namespace dsh-sandbox"
