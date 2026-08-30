#!/usr/bin/env bash
set -euo pipefail

readonly KAS_VERSION="v0.5.4"
readonly INSTALL_URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${KAS_VERSION}/sandbox-with-extensions.yaml"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="dsh-kas"
RUNNER_IMAGE=""
HOST_IMAGE=""
PUBLIC_KEY_FILE=""
LOAD_IMAGE=false

usage() {
  cat <<'EOF'
Usage: dev-cluster.sh --runner-image IMAGE (--public-key-file FILE | --host-image IMAGE)
                      [--load-runner-image] [--name NAME]

Creates/reuses a kind cluster, installs agent-sandbox v0.5.4, and applies the
reference environment. --load-runner-image loads existing local Docker images
(the runner, and the host when --host-image is set) into kind.

With --host-image, the dsh host runs in-cluster and the runner public key is
read from its pod, where the key is generated on first boot. Without it, dsh
runs outside the cluster and FILE must contain that provider's Ed25519 public
key in PEM form.
EOF
}

while (($#)); do
  case "$1" in
    --runner-image) [[ $# -ge 2 ]] || { echo "error: --runner-image needs a value" >&2; exit 2; }; RUNNER_IMAGE="$2"; shift 2 ;;
    --host-image) [[ $# -ge 2 ]] || { echo "error: --host-image needs a value" >&2; exit 2; }; HOST_IMAGE="$2"; shift 2 ;;
    --public-key-file) [[ $# -ge 2 ]] || { echo "error: --public-key-file needs a value" >&2; exit 2; }; PUBLIC_KEY_FILE="$2"; shift 2 ;;
    --load-runner-image) LOAD_IMAGE=true; shift ;;
    --name) [[ $# -ge 2 ]] || { echo "error: --name needs a value" >&2; exit 2; }; CLUSTER_NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for command in kind kubectl sed; do
  command -v "$command" >/dev/null || { echo "error: required command not found: $command" >&2; exit 1; }
done
[[ -n "$RUNNER_IMAGE" ]] || { echo "error: --runner-image is required (the checked-in manifest intentionally has a placeholder)" >&2; exit 2; }
if [[ -n "$HOST_IMAGE" && -n "$PUBLIC_KEY_FILE" ]]; then
  echo "error: --host-image and --public-key-file conflict: an in-cluster host signs with its own pod key" >&2; exit 2
fi
if [[ -z "$HOST_IMAGE" ]]; then
  [[ -n "$PUBLIC_KEY_FILE" ]] || { echo "error: either --public-key-file or --host-image is required" >&2; exit 2; }
  [[ -r "$PUBLIC_KEY_FILE" ]] || { echo "error: cannot read public key: $PUBLIC_KEY_FILE" >&2; exit 2; }
  grep -q -- 'BEGIN PUBLIC KEY' "$PUBLIC_KEY_FILE" || { echo "error: public key file is not PEM encoded" >&2; exit 2; }
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

# Apply the key before creating warm pods, then substitute only the deliberate
# image tokens. Applying the checked-in kustomization directly would install
# its intentionally invalid example key.
kubectl apply -f "$ROOT_DIR/deploy/kubernetes/00-namespace.yaml"
kubectl -n dsh-sandbox delete sandboxwarmpool dsh-universal --ignore-not-found --wait=true
kubectl apply -f "$ROOT_DIR/deploy/kubernetes/40-provider-rbac.yaml"

if [[ -n "$HOST_IMAGE" ]]; then
  # The in-cluster host generates its signing key on first boot; read the
  # public half from the pod so warm runners trust the right provider.
  sed "s|DSH_HOST_IMAGE_PLACEHOLDER|${HOST_IMAGE//&/\\&}|g" \
    "$ROOT_DIR/deploy/kubernetes/50-host.yaml" \
    | kubectl apply -f -
  kubectl -n dsh-sandbox rollout status deployment/dsh-host --timeout=300s
  PUBLIC_KEY_FILE="$(mktemp)"
  trap 'rm -f "$PUBLIC_KEY_FILE"' EXIT
  kubectl -n dsh-sandbox exec deploy/dsh-host -- dsh-workbench key public >"$PUBLIC_KEY_FILE"
  grep -q -- 'BEGIN PUBLIC KEY' "$PUBLIC_KEY_FILE" || { echo "error: the host pod did not print a PEM public key" >&2; exit 1; }
fi

kubectl -n dsh-sandbox create configmap dsh-runner-public-key \
  --from-file="public-key.pem=$PUBLIC_KEY_FILE" \
  --dry-run=client -o yaml \
  | kubectl apply -f -
sed "s|DSH_RUNNER_IMAGE_PLACEHOLDER|${RUNNER_IMAGE//&/\\&}|g" \
  "$ROOT_DIR/deploy/kubernetes/20-sandbox-template.yaml" \
  | kubectl apply -f -
kubectl apply -f "$ROOT_DIR/deploy/kubernetes/30-warm-pool.yaml"

echo "Waiting for warm capacity..."
kubectl -n dsh-sandbox wait --for=jsonpath='{.status.readyReplicas}'=1 sandboxwarmpool/dsh-universal --timeout=300s
echo "Ready. Run: scripts/kas/smoke-test.sh --namespace dsh-sandbox"
