#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="dsh-sandbox"
WARM_POOL="dsh-universal"
TIMEOUT="300s"
MAIN_CLAIM=""
DISPOSABLE_CLAIM=""
SUCCESS=false

usage() { echo "Usage: smoke-test.sh [--namespace NS] [--warm-pool NAME] [--timeout DURATION]"; }
while (($#)); do
  case "$1" in
    -n|--namespace) [[ $# -ge 2 ]] || { echo "error: $1 needs a value" >&2; exit 2; }; NAMESPACE="$2"; shift 2 ;;
    --warm-pool) [[ $# -ge 2 ]] || { echo "error: --warm-pool needs a value" >&2; exit 2; }; WARM_POOL="$2"; shift 2 ;;
    --timeout) [[ $# -ge 2 ]] || { echo "error: --timeout needs a value" >&2; exit 2; }; TIMEOUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cleanup() {
  [[ -z "$DISPOSABLE_CLAIM" ]] || kubectl -n "$NAMESPACE" delete sandboxclaim "$DISPOSABLE_CLAIM" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if $SUCCESS && [[ -n "$MAIN_CLAIM" ]]; then
    kubectl -n "$NAMESPACE" delete sandboxclaim "$MAIN_CLAIM" --ignore-not-found --wait=true >/dev/null
  elif [[ -n "$MAIN_CLAIM" ]]; then
    echo "FAILED: preserving SandboxClaim/$MAIN_CLAIM in $NAMESPACE for debugging" >&2
  fi
}
trap cleanup EXIT

for command in kubectl python3; do
  command -v "$command" >/dev/null || { echo "error: required command not found: $command" >&2; exit 1; }
done
kubectl cluster-info >/dev/null 2>&1 || { echo "error: current kube context is not reachable" >&2; exit 1; }
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || { echo "error: namespace '$NAMESPACE' does not exist" >&2; exit 1; }
kubectl -n "$NAMESPACE" get sandboxwarmpool "$WARM_POOL" >/dev/null 2>&1 || { echo "error: warm pool '$WARM_POOL' not found in '$NAMESPACE'" >&2; exit 1; }

suffix="$(date +%s)-$RANDOM"
MAIN_CLAIM="kas-smoke-$suffix"
start_ms="$(python3 -c 'import time; print(time.time_ns() // 1_000_000)')"
kubectl -n "$NAMESPACE" create -f - <<EOF
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: $MAIN_CLAIM
spec:
  warmPoolRef:
    name: $WARM_POOL
EOF

sandbox=""
deadline=$((SECONDS + 60))
until [[ -n "$sandbox" ]]; do
  (( SECONDS < deadline )) || { echo "error: claim was not assigned a Sandbox within 60s" >&2; exit 1; }
  sandbox="$(kubectl -n "$NAMESPACE" get sandboxclaim "$MAIN_CLAIM" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)"
  [[ -n "$sandbox" ]] || sleep 0.05
done
adoption_ms=$(( $(python3 -c 'import time; print(time.time_ns() // 1_000_000)') - start_ms ))
echo "Adopted Sandbox/$sandbox in ${adoption_ms}ms"
(( adoption_ms < 1000 )) || { echo "error: warm Sandbox adoption took 1s or longer" >&2; exit 1; }
kubectl -n "$NAMESPACE" wait --for=condition=Ready "sandboxclaim/$MAIN_CLAIM" --timeout="$TIMEOUT"

fqdn="$(kubectl -n "$NAMESPACE" get sandbox "$sandbox" -o jsonpath='{.status.serviceFQDN}')"
[[ -n "$fqdn" ]] || { echo "error: Sandbox has no service endpoint" >&2; exit 1; }
echo "Endpoint: ${fqdn}:8080"
selector="$(kubectl -n "$NAMESPACE" get sandbox "$sandbox" -o jsonpath='{.status.selector}')"
[[ -n "$selector" ]] || { echo "error: Sandbox has no status.selector" >&2; exit 1; }
pod="$(kubectl -n "$NAMESPACE" get pods -l "$selector" -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$pod" ]] || { echo "error: could not discover Sandbox pod" >&2; exit 1; }
[[ "$pod" == "$sandbox" ]] || { echo "error: backing pod name does not match Sandbox identity" >&2; exit 1; }
kubectl -n "$NAMESPACE" exec "$pod" -c runner -- curl --fail --silent --show-error http://127.0.0.1:8080/health >/dev/null
pvc="$(kubectl -n "$NAMESPACE" get pod "$pod" -o jsonpath='{.spec.volumes[?(@.name=="workspace")].persistentVolumeClaim.claimName}')"
[[ -n "$pvc" ]] || { echo "error: workspace PVC not mounted" >&2; exit 1; }
sentinel="dsh-kas-$suffix"
kubectl -n "$NAMESPACE" exec "$pod" -c runner -- sh -c 'printf %s "$1" > /workspace/.kas-smoke-sentinel' sh "$sentinel"

kubectl -n "$NAMESPACE" patch sandbox "$sandbox" --type=merge -p '{"spec":{"operatingMode":"Suspended"}}'
deadline=$((SECONDS + 120))
while kubectl -n "$NAMESPACE" get pods -l "$selector" -o name | grep -q .; do
  (( SECONDS < deadline )) || { echo "error: pod still exists after suspension" >&2; exit 1; }
  sleep 1
done
kubectl -n "$NAMESPACE" get pvc "$pvc" >/dev/null
echo "Suspended: pod removed; PVC/$pvc remains"

resume_start_ms="$(python3 -c 'import time; print(time.time_ns() // 1_000_000)')"
kubectl -n "$NAMESPACE" patch sandbox "$sandbox" --type=merge -p '{"spec":{"operatingMode":"Running"}}'
kubectl -n "$NAMESPACE" wait --for=condition=Ready "sandbox/$sandbox" --timeout="$TIMEOUT"
pod="$(kubectl -n "$NAMESPACE" get pods -l "$selector" -o jsonpath='{.items[0].metadata.name}')"
actual="$(kubectl -n "$NAMESPACE" exec "$pod" -c runner -- cat /workspace/.kas-smoke-sentinel)"
[[ "$actual" == "$sentinel" ]] || { echo "error: sentinel did not survive resume" >&2; exit 1; }
resume_ms=$(( $(python3 -c 'import time; print(time.time_ns() // 1_000_000)') - resume_start_ms ))
echo "Resumed in ${resume_ms}ms; workspace sentinel verified"

DISPOSABLE_CLAIM="kas-expiry-$suffix"
shutdown_time="$(python3 -c 'from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) + timedelta(seconds=30)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
kubectl -n "$NAMESPACE" create -f - <<EOF
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: $DISPOSABLE_CLAIM
spec:
  warmPoolRef:
    name: $WARM_POOL
  lifecycle:
    shutdownTime: "$shutdown_time"
    shutdownPolicy: DeleteForeground
EOF
kubectl -n "$NAMESPACE" wait --for=condition=Ready "sandboxclaim/$DISPOSABLE_CLAIM" --timeout="$TIMEOUT"
expiry_sandbox="$(kubectl -n "$NAMESPACE" get sandboxclaim "$DISPOSABLE_CLAIM" -o jsonpath='{.status.sandbox.name}')"
[[ -n "$expiry_sandbox" ]] || { echo "error: expiring claim has no assigned Sandbox" >&2; exit 1; }
expiry_selector="$(kubectl -n "$NAMESPACE" get sandbox "$expiry_sandbox" -o jsonpath='{.status.selector}')"
[[ -n "$expiry_selector" ]] || { echo "error: expiring Sandbox has no pod selector" >&2; exit 1; }
expiry_pod="$(kubectl -n "$NAMESPACE" get pods -l "$expiry_selector" -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$expiry_pod" ]] || { echo "error: expiring Sandbox has no pod" >&2; exit 1; }
expiry_pvc="$(kubectl -n "$NAMESPACE" get pod "$expiry_pod" -o jsonpath='{.spec.volumes[?(@.name=="workspace")].persistentVolumeClaim.claimName}')"
[[ -n "$expiry_pvc" ]] || { echo "error: expiring Sandbox has no workspace PVC" >&2; exit 1; }
echo "Waiting for foreground expiry of SandboxClaim/$DISPOSABLE_CLAIM..."
kubectl -n "$NAMESPACE" wait --for=delete "sandboxclaim/$DISPOSABLE_CLAIM" --timeout=180s
DISPOSABLE_CLAIM=""
kubectl -n "$NAMESPACE" wait --for=delete "sandbox/$expiry_sandbox" --timeout=180s
kubectl -n "$NAMESPACE" wait --for=delete "pvc/$expiry_pvc" --timeout=180s
echo "shutdownTime foreground deletion and workspace cleanup verified"

SUCCESS=true
echo "PASS: agent-sandbox warm adoption, suspend/resume persistence, and expiry"
