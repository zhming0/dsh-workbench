#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="${DSH_KAS_CLUSTER_NAME:-dsh-kas-e2e}"
RUNNER_IMAGE="${DSH_RUNNER_IMAGE:-dsh-runner:dev}"
HOST_IMAGE="${DSH_HOST_IMAGE:-dsh-host:dev}"
NAMESPACE="dsh-sandbox"
JOB="dsh-kas-rpc-smoke"
TOKEN_FILE="$(mktemp)"
SUCCESS=false

cleanup() {
  local status=$?
  if ! $SUCCESS && kind get clusters 2>/dev/null | grep -Fxq "$CLUSTER_NAME"; then
    echo "--- Kubernetes diagnostics"
    kubectl -n "$NAMESPACE" get sandboxclaims,sandboxes,pods,pvc,jobs -o wide || true
    kubectl -n "$NAMESPACE" describe pods || true
    kubectl -n "$NAMESPACE" logs "job/$JOB" --all-containers=true || true
    while read -r pod; do
      kubectl -n "$NAMESPACE" logs "$pod" -c runner || true
    done < <(kubectl -n "$NAMESPACE" get pods -o name 2>/dev/null)
    kubectl -n agent-sandbox-system logs deployment/agent-sandbox-controller --all-containers=true --tail=200 || true
  fi
  rm -f "$TOKEN_FILE"
  if [[ "${KEEP_KAS_CLUSTER:-0}" == "1" ]]; then
    echo "Keeping kind cluster '$CLUSTER_NAME' for debugging"
  else
    "$ROOT_DIR/scripts/kas/teardown.sh" --name "$CLUSTER_NAME" || true
  fi
  return "$status"
}
trap cleanup EXIT

for command in docker kind kubectl od; do
  command -v "$command" >/dev/null || { echo "error: required command not found: $command" >&2; exit 1; }
done
docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1 || { echo "error: local image not found: $RUNNER_IMAGE" >&2; exit 1; }
docker image inspect "$HOST_IMAGE" >/dev/null 2>&1 || { echo "error: local image not found: $HOST_IMAGE" >&2; exit 1; }

od -vN 32 -An -tx1 /dev/urandom | tr -d ' \n' >"$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

# Create the tunnel Service before the warm runner. The test uses its stable
# ClusterIP so starting the runner cannot race Service DNS publication.
if ! kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --wait 120s
fi
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null
kubectl apply -f "$ROOT_DIR/deploy/kubernetes/00-namespace.yaml"
kubectl apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: dsh-host-tunnel
  namespace: $NAMESPACE
spec:
  selector:
    app.kubernetes.io/name: dsh-host
  ports:
    - name: tunnel
      port: 8081
      targetPort: tunnel
EOF
HOST_SERVICE_IP="$(kubectl -n "$NAMESPACE" get service dsh-host-tunnel -o jsonpath='{.spec.clusterIP}')"

"$ROOT_DIR/scripts/kas/dev-cluster.sh" \
  --name "$CLUSTER_NAME" \
  --runner-image "$RUNNER_IMAGE" \
  --host-url "tcp://${HOST_SERVICE_IP}:8081" \
  --registration-token-file "$TOKEN_FILE" \
  --load-runner-image \
  --skip-warm-pool

kind load docker-image --name "$CLUSTER_NAME" "$HOST_IMAGE"

kubectl -n "$NAMESPACE" create configmap dsh-kas-rpc-smoke \
  --from-file="rpc-smoke.mjs=$ROOT_DIR/scripts/kas/rpc-smoke.mjs" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB
  namespace: $NAMESPACE
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        app.kubernetes.io/name: dsh-host
    spec:
      restartPolicy: Never
      serviceAccountName: dsh-provider
      containers:
        - name: smoke
          image: $HOST_IMAGE
          imagePullPolicy: IfNotPresent
          command: [node, /test/rpc-smoke.mjs]
          env:
            - name: REGISTRATION_TOKEN
              valueFrom:
                secretKeyRef:
                  name: dsh-registration-token
                  key: token
          ports:
            - name: tunnel
              containerPort: 8081
          readinessProbe:
            tcpSocket:
              port: tunnel
            periodSeconds: 1
          volumeMounts:
            - name: test
              mountPath: /test
              readOnly: true
      volumes:
        - name: test
          configMap:
            name: dsh-kas-rpc-smoke
  ttlSecondsAfterFinished: 300
EOF

# Do not start a runner until the host Job is accepting tunnel connections.
kubectl -n "$NAMESPACE" wait --for=condition=Ready pod \
  -l job-name="$JOB" --timeout=120s
kubectl apply -f "$ROOT_DIR/deploy/kubernetes/30-warm-pool.yaml"

deadline=$((SECONDS + 300))
while true; do
  job_condition="$(kubectl -n "$NAMESPACE" get job "$JOB" -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\n"}{end}')"
  grep -qx 'Complete=True' <<<"$job_condition" && break
  if grep -qx 'Failed=True' <<<"$job_condition"; then
    echo "error: Kubernetes RPC smoke Job failed" >&2
    exit 1
  fi
  (( SECONDS < deadline )) || { echo "error: Kubernetes RPC smoke Job timed out" >&2; exit 1; }
  sleep 2
done
kubectl -n "$NAMESPACE" logs "job/$JOB"

# The existing controller smoke covers warm-adoption latency and terminal
# expiry in addition to the transport probe's provider-owned lifecycle path.
kubectl -n "$NAMESPACE" wait --for=jsonpath='{.status.readyReplicas}'=1 \
  sandboxwarmpool/dsh-universal --timeout=300s
"$ROOT_DIR/scripts/kas/smoke-test.sh" --namespace "$NAMESPACE"

SUCCESS=true
echo "PASS: Kubernetes agent-sandbox transport and lifecycle"
