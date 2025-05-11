#!/bin/bash

set -euo pipefail

K3S_VERSION="v1.31.3+k3s1"
CERT_MANAGER_VERSION="v1.17.0"
RANCHER_NAMESPACE="cattle-system"
CERT_NAMESPACE="cert-manager"
RANCHER_DOMAIN="__RANCHER_DOMAIN__"
EMAIL="__YOUR_EMAIL__"
ADMIN_PASSWORD="__ADMIN_PASSWORD__"
CLI_PASSWORD="__CLI_PASSWORD__"
RANCHER_URL="https://${RANCHER_DOMAIN}"

log() {
  echo "[*] $1"
}

apt update
apt install -y curl jq openssl

BOOTSTRAP_PASSWORD=$(openssl rand -hex 22)
log "Generated bootstrap password: ${BOOTSTRAP_PASSWORD}"

wait_for_namespace() {
  local ns=$1
  log "Waiting for namespace '${ns}' to become active..."
  for i in {1..12}; do
    if kubectl get ns "${ns}" >/dev/null 2>&1; then
      log "Namespace '${ns}' is ready."
      return 0
    fi
    sleep 5
  done
  echo "[!] ERROR: Namespace '${ns}' did not become active in time."
  exit 1
}

wait_for_deployment() {
  local deploy=$1
  local ns=$2
  log "Waiting for deployment '${deploy}' in namespace '${ns}'..."
  kubectl rollout status deployment "${deploy}" -n "${ns}" --timeout=600s
}

log "Installing K3s..."
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=${K3S_VERSION} sh -

log "Waiting for K3s node to be ready..."
for i in {1..12}; do
  if kubectl get nodes >/dev/null 2>&1; then
    log "K3s is ready."
    break
  fi
  sleep 5
done

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

if ! command -v helm &>/dev/null; then
  log "Installing Helm..."
  curl https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 | bash
else
  log "Helm already installed."
fi

helm repo add rancher-stable https://releases.rancher.com/server-charts/stable
helm repo add jetstack https://charts.jetstack.io
helm repo update

kubectl create namespace "${RANCHER_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace "${CERT_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
wait_for_namespace "${CERT_NAMESPACE}"
wait_for_namespace "${RANCHER_NAMESPACE}"

log "Installing cert-manager..."
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace "${CERT_NAMESPACE}" \
  --version "${CERT_MANAGER_VERSION}" \
  --set crds.enabled=true \
  --set webhook.timeoutSeconds=30

wait_for_deployment cert-manager "${CERT_NAMESPACE}"
wait_for_deployment cert-manager-webhook "${CERT_NAMESPACE}"

log "Creating ClusterIssuer for Let's Encrypt..."
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-http
spec:
  acme:
    email: ${EMAIL}
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-http-private-key
    solvers:
      - http01:
          ingress:
            class: traefik
EOF

log "Installing Rancher with Let's Encrypt..."
helm upgrade --install rancher rancher-stable/rancher \
  --namespace "${RANCHER_NAMESPACE}" \
  --set hostname="${RANCHER_DOMAIN}" \
  --set bootstrapPassword="${BOOTSTRAP_PASSWORD}" \
  --set ingress.tls.source=rancher \
  --set replicas=1 \
  
wait_for_deployment rancher "${RANCHER_NAMESPACE}"

log "Waiting for Rancher to become available..."
while true; do
  status_code=$(curl -k -s -o /dev/null -w "%{http_code}" "${RANCHER_URL}")
  if [ "$status_code" -ge 200 ] && [ "$status_code" -lt 400 ]; then
    log "Rancher is ready (HTTP $status_code)."
    break
  else
    log "Rancher not ready yet (HTTP $status_code), retrying in 5s..."
    sleep 5
  fi
done

log "Authenticating with bootstrap password..."
LOGIN_RESPONSE=$(curl -sk "${RANCHER_URL}/v3-public/localProviders/local?action=login" \
  -H 'Content-Type: application/json' \
  --data "{\"username\":\"admin\",\"password\":\"${BOOTSTRAP_PASSWORD}\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r .token)

if [ "$TOKEN" == "null" ] || [ -z "$TOKEN" ]; then
  echo "[!] Authentication failed. Check the Rancher URL or bootstrap password."
  exit 1
fi
log "Authenticated. Token retrieved."

sleep 5

log "Changing admin password..."
curl -sk -X POST "${RANCHER_URL}/v3/users?action=changepassword" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{\"currentPassword\":\"${BOOTSTRAP_PASSWORD}\",\"newPassword\":\"${ADMIN_PASSWORD}\"}"

log "Admin password updated."

log "Retrieving new token using updated password..."
LOGIN_RESPONSE=$(curl -sk "${RANCHER_URL}/v3-public/localProviders/local?action=login" \
  -H 'Content-Type: application/json' \
  --data "{\"username\":\"admin\",\"password\":\"${ADMIN_PASSWORD}\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r .token)

if [ "$TOKEN" == "null" ] || [ -z "$TOKEN" ]; then
  echo "[!] Authentication failed with new password."
  exit 1
fi
log "New token successfully retrieved."

log "Configuring Rancher public URL..."
curl -sk -X PUT "${RANCHER_URL}/v3/settings/server-url" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{\"value\":\"${RANCHER_URL}\"}"

log "Rancher public URL set to ${RANCHER_URL}."

log "Creating 'cli' user..."
CREATE_USER_PAYLOAD=$(cat <<EOF
{
  "username": "cli",
  "password": "${CLI_PASSWORD}",
  "enabled": true,
  "mustChangePassword": false,
  "description": "Ansible user for automation",
  "name": "Ansible User"
}
EOF
)

USER_RESPONSE=$(curl -sk -X POST "${RANCHER_URL}/v3/users" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${CREATE_USER_PAYLOAD}")

USER_ID=$(echo "$USER_RESPONSE" | jq -r .id)

if [ "$USER_ID" == "null" ] || [ -z "$USER_ID" ]; then
  echo "[!] Failed to create cli user."
  exit 1
fi
log "'cli' user created with ID: $USER_ID"

log "Assigning admin role to 'cli' user..."
curl -sk -X POST "${RANCHER_URL}/v3/globalrolebindings" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{
    \"globalRoleId\": \"admin\",
    \"userId\": \"${USER_ID}\"
  }"

log "Admin role granted to 'cli' user."

echo "[✅] Rancher installation and Ansible user setup completed successfully."
