#!/bin/bash

RANCHER_URL=__RANCHER_URL__
RANCHER_AGENT_TOKEN=__RANCHER_AGENT_TOKEN__

# Install prerequisites
apt-get update
apt-get install -y curl ca-certificates jq

# Calculate checksum dynamically from Rancher URL
CHECKSUM=$(curl -sk "$RANCHER_URL/cacerts" | sha256sum | awk '{ print $1 }')

# Install Rancher agent with worker roles
curl --insecure -fL "$RANCHER_URL/system-agent-install.sh" | \
sudo sh -s - \
    --server "$RANCHER_URL" \
    --label 'cattle.io/os=linux' \
    --token "$RANCHER_AGENT_TOKEN" \
    --ca-checksum "$CHECKSUM" \
    --worker
