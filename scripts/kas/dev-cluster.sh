#!/usr/bin/env bash
set -euo pipefail

readonly KAS_VERSION="v1.0.2"
readonly INSTALL_URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${KAS_VERSION}/sandbox-with-extensions.yaml"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="dsh-kas"
RUNNER_IMAGE=""
CONTROL_PLANE_IMAGE=""
DSH_YAWN_CONTROL_PLANE_URL=""
TOKEN_FILE=""
LOAD_IMAGE=false
SKIP_WARM_POOL=false

usage() {
  cat <<'EOF'
Usage: dev-cluster.sh --runner-image IMAGE (--control-plane-image IMAGE | --control-plane-url URL)
                      [--registration-token-file FILE]
                      [--load-runner-image] [--skip-warm-pool] [--name NAME]

Creates/reuses a kind cluster, installs agent-sandbox v1.0.2, and applies the
reference environment. --load-runner-image loads existing local Docker images
(the runner, and the control plane when --control-plane-image is set) into kind.
--skip-warm-pool applies the SandboxTemplate but leaves warm-pool creation to
the caller.

With --control-plane-image, the control plane runs in-cluster and runners dial its
dsh-yawn-control-plane-tunnel Service. With --control-plane-url, dsh runs outside the cluster and
runners dial URL instead (ws://.../tunnel or wss://.../tunnel; the address must be
reachable from pods, and the sandbox NetworkPolicy must be widened to it).

The registration token is read from FILE when given, otherwise generated.
Either way it lands in the dsh-yawn-registration-token Secret that both the
control plane and the warm runners read. With --control-plane-url, pass the same
token to the external control plane via DSH_YAWN_REGISTRATION_TOKEN.
EOF
}

while (($#)); do
  case "$1" in
    --runner-image) [[ $# -ge 2 ]] || { echo "error: --runner-image needs a value" >&2; exit 2; }; RUNNER_IMAGE="$2"; shift 2 ;;
    --control-plane-image) [[ $# -ge 2 ]] || { echo "error: --control-plane-image needs a value" >&2; exit 2; }; CONTROL_PLANE_IMAGE="$2"; shift 2 ;;
    --control-plane-url) [[ $# -ge 2 ]] || { echo "error: --control-plane-url needs a value" >&2; exit 2; }; DSH_YAWN_CONTROL_PLANE_URL="$2"; shift 2 ;;
    --registration-token-file) [[ $# -ge 2 ]] || { echo "error: --registration-token-file needs a value" >&2; exit 2; }; TOKEN_FILE="$2"; shift 2 ;;
    --load-runner-image) LOAD_IMAGE=true; shift ;;
    --skip-warm-pool) SKIP_WARM_POOL=true; shift ;;
    --name) [[ $# -ge 2 ]] || { echo "error: --name needs a value" >&2; exit 2; }; CLUSTER_NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for command in kind kubectl sed od; do
  command -v "$command" >/dev/null || { echo "error: required command not found: $command" >&2; exit 1; }
done
[[ -n "$RUNNER_IMAGE" ]] || { echo "error: --runner-image is required (the checked-in manifest intentionally has a placeholder)" >&2; exit 2; }
if [[ -n "$CONTROL_PLANE_IMAGE" && -n "$DSH_YAWN_CONTROL_PLANE_URL" ]]; then
  echo "error: --control-plane-image and --control-plane-url conflict: pick in-cluster or external control plane" >&2; exit 2
fi
if [[ -z "$CONTROL_PLANE_IMAGE" && -z "$DSH_YAWN_CONTROL_PLANE_URL" ]]; then
  echo "error: either --control-plane-image or --control-plane-url is required (runners must know where to dial)" >&2; exit 2
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
  for image in "$RUNNER_IMAGE" ${CONTROL_PLANE_IMAGE:+"$CONTROL_PLANE_IMAGE"}; do
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

# The control plane is the Helm chart, rendered rather than installed so the
# script controls the images, the token, and whether a control-plane Deployment exists.
# The sandbox pool is the kustomize base. Both go through the same artifacts an
# operator uses.
overlay="$(mktemp -d "$ROOT_DIR/.dsh-dev-cluster.XXXXXX")"
trap 'rm -rf "$overlay"' EXIT

cat >"$overlay/kustomization.yaml" <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
# The pool base names no namespace: the overlay supplies the one the
# control plane lives in.
namespace: dsh-yawn
resources:
  - ../deploy/kubernetes/runner
EOF

cat >>"$overlay/kustomization.yaml" <<EOF
images:
  - name: ghcr.io/zhming0/dsh-yawn-runner
    newName: ${RUNNER_IMAGE%%:*}
    newTag: ${RUNNER_IMAGE##*:}
EOF

# Patches accumulate in one list; kustomize rejects a repeated `patches` key.
patches=()

if $SKIP_WARM_POOL; then
  cat >"$overlay/delete-warm-pool.yaml" <<'EOF'
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata:
  name: dsh-yawn-universal
$patch: delete
EOF
  patches+=("delete-warm-pool.yaml")
fi

if ((${#patches[@]})); then
  printf 'patches:\n' >>"$overlay/kustomization.yaml"
  for patch in "${patches[@]}"; do
    printf '  - path: %s\n' "$patch" >>"$overlay/kustomization.yaml"
  done
fi

# The namespace and the registration Secret both have to exist before the
# control plane and warm pods start. The Secret never goes through the chart here, so
# that its value stays under the script's control.
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: dsh-yawn
EOF
if [[ -n "$TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
  [[ -n "$TOKEN" ]] || { echo "error: token file is empty" >&2; exit 2; }
else
  TOKEN="$(od -vN 32 -An -tx1 /dev/urandom | tr -d ' \n')"
fi
kubectl -n dsh-yawn create secret generic dsh-yawn-registration-token \
  --from-literal="token=$TOKEN" \
  --dry-run=client -o yaml \
  | kubectl apply -f -

if [[ -n "$CONTROL_PLANE_IMAGE" ]]; then
  # In-cluster control plane: the whole chart, with the locally built images and the
  # profile naming the warm pool this script applies. The seed alone is
  # `profiles: {}`, so without it the control plane boots but cannot provision.
  helm template dsh-yawn-control-plane "$ROOT_DIR/deploy/helm/dsh-yawn" \
    --namespace dsh-yawn \
    --set registrationToken.existingSecret=dsh-yawn-registration-token \
    --set "controlPlane.image.repository=${CONTROL_PLANE_IMAGE%%:*}" \
    --set "controlPlane.image.tag=${CONTROL_PLANE_IMAGE##*:}" \
    --set controlPlane.sandboxManager.profiles.standard.backend=kas \
    --set controlPlane.sandboxManager.profiles.standard.warmPool=dsh-yawn-universal \
    | kubectl apply -f -
else
  # External control plane: its identity and permissions, plus the
  # runner-config ConfigMap DSH_YAWN_CONTROL_PLANE_URL comes from. dsh itself is elsewhere.
  helm template dsh-yawn-control-plane "$ROOT_DIR/deploy/helm/dsh-yawn" \
    --namespace dsh-yawn \
    --set registrationToken.existingSecret=dsh-yawn-registration-token \
    --set "runner.controlPlaneUrl=$DSH_YAWN_CONTROL_PLANE_URL" \
    --show-only templates/control-plane-rbac.yaml \
    --show-only templates/runner-config-configmap.yaml \
    | kubectl apply -f -
fi
unset TOKEN

kubectl kustomize "$overlay" | kubectl apply -f -

if [[ -n "$CONTROL_PLANE_IMAGE" ]]; then
  kubectl -n dsh-yawn rollout status deployment/dsh-yawn-control-plane --timeout=300s
fi

if ! $SKIP_WARM_POOL; then
  echo "Waiting for warm capacity..."
  kubectl -n dsh-yawn wait --for=jsonpath='{.status.readyReplicas}'=1 sandboxwarmpool/dsh-yawn-universal --timeout=300s
  echo "Ready. Run: scripts/kas/smoke-test.sh --namespace dsh-yawn"
fi
