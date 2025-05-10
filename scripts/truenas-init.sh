#!/bin/bash

set -euo pipefail

STORAGE_IP="__STORAGE_IP__"
ADMIN_PASSWORD="__ADMIN_PASSWORD__"
ADMIN_EMAIL="__ADMIN_EMAIL__"
STORAGE_NODE_NAME="__STORAGE_NODE_NAME__"
API_KEY="__API_KEY__"

# Logging
LOG_FILE="/tmp/truenas-init.log"
exec > >(tee -a ${LOG_FILE}) 2>&1
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }
log "Initialisation TrueNAS sur $STORAGE_IP"

# Installer jq si nécessaire
if ! command -v jq &> /dev/null; then
    log "Installation de jq"
    apt-get update && apt-get install -y jq curl
fi

# Attendre que l'API soit disponible
log "Attente de l'API TrueNAS..."
for i in {1..60}; do
    if curl -s -k "https://${STORAGE_IP}/api/v2.0" > /dev/null; then
        log "API TrueNAS disponible"
        break
    fi
    if [ $i -eq 60 ]; then
        log "ERREUR: API TrueNAS non disponible après 60 tentatives"
        exit 1
    fi
    sleep 10
done

# Authentification - Essayer d'abord admin/admin puis avec le mot de passe configuré
log "Authentification..."
TOKEN=$(curl -s -k -X POST \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"admin"}' \
    "https://${STORAGE_IP}/api/v2.0/auth/token" | jq -r '.token // empty')

if [ -z "$TOKEN" ]; then
    TOKEN=$(curl -s -k -X POST \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" \
        "https://${STORAGE_IP}/api/v2.0/auth/token" | jq -r '.token // empty')
fi

if [ -z "$TOKEN" ]; then
    log "ERREUR: Échec d'authentification"
    exit 1
fi

# Fonction pour les appels API
api_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    
    if [ -z "$data" ]; then
        curl -s -k -X "$method" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            "https://${STORAGE_IP}/api/v2.0/${endpoint}"
    else
        curl -s -k -X "$method" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            -d "$data" \
            "https://${STORAGE_IP}/api/v2.0/${endpoint}"
    fi
}

# Mise à jour du mot de passe admin
if [[ "$ADMIN_PASSWORD" != "admin" && "$ADMIN_PASSWORD" != "__ADMIN_PASSWORD__" ]]; then
    log "Mise à jour du mot de passe admin"
    USER_ID=$(api_call GET "user" | jq '.[] | select(.username=="admin") | .id')
    if [ -n "$USER_ID" ]; then
        api_call PUT "user/id/$USER_ID" "{\"password\":\"$ADMIN_PASSWORD\",\"email\":\"$ADMIN_EMAIL\"}"
    fi
fi

# Identification du disque de données
log "Recherche du disque de données"
DISKS_DATA=$(api_call GET "disk")
DATA_DISK=$(echo "$DISKS_DATA" | jq -r '.[] | select(.name != "sda") | .name' | head -1)

if [ -z "$DATA_DISK" ]; then
    log "ERREUR: Pas de disque de données trouvé"
    exit 1
fi

log "Disque de données: $DATA_DISK"

# Création du pool ZFS si nécessaire
POOL_EXISTS=$(api_call GET "pool" | jq -r '.[] | select(.name=="data") | .name')
if [ -z "$POOL_EXISTS" ]; then
    log "Création du pool ZFS 'data'"
    POOL_DATA="{\"name\":\"data\",\"topology\":{\"data\":[{\"type\":\"STRIPE\",\"disks\":[\"$DATA_DISK\"]}]}}"
    api_call POST "pool" "$POOL_DATA"
    sleep 5
else
    log "Pool 'data' déjà existant"
fi

# Création des datasets
for DS in "data/shares" "data/iscsi" "data/nfs"; do
    DS_EXISTS=$(api_call GET "pool/dataset" | jq -r ".[] | select(.name==\"$DS\") | .name")
    if [ -z "$DS_EXISTS" ]; then
        log "Création du dataset $DS"
        DS_DATA="{\"name\":\"$DS\",\"type\":\"FILESYSTEM\",\"compression\":\"LZ4\"}"
        api_call POST "pool/dataset" "$DS_DATA"
    else
        log "Dataset $DS déjà existant"
    fi
done

# Configuration NFS
NFS_EXISTS=$(api_call GET "sharing/nfs" | jq -r '.[] | select(.paths[0]=="/mnt/data/shares") | .id')
if [ -z "$NFS_EXISTS" ]; then
    log "Configuration du partage NFS"
    NFS_DATA="{\"paths\":[\"/mnt/data/shares\"],\"enabled\":true,\"mapall_user\":\"root\",\"mapall_group\":\"root\"}"
    api_call POST "sharing/nfs" "$NFS_DATA"
fi

# Activation du service NFS
api_call PUT "service/id/nfs" "{\"enable\":true}"
api_call POST "service/start" '{"service":"nfs"}'

# Configuration iSCSI
# 1. Portal
PORTAL_ID=$(api_call GET "iscsi/portal" | jq -r '.[] | select(.comment=="Default") | .id')
if [ -z "$PORTAL_ID" ]; then
    log "Création du portal iSCSI"
    PORTAL_DATA="{\"comment\":\"Default\",\"listen\":[{\"ip\":\"0.0.0.0\",\"port\":3260}]}"
    PORTAL_ID=$(api_call POST "iscsi/portal" "$PORTAL_DATA" | jq -r '.id')
fi

# 2. Initiator
INITIATOR_ID=$(api_call GET "iscsi/initiator" | jq -r '.[] | select(.comment=="Default") | .id')
if [ -z "$INITIATOR_ID" ]; then
    log "Création de l'initiator iSCSI"
    INITIATOR_DATA="{\"comment\":\"Default\",\"initiators\":[],\"auth_network\":[\"0.0.0.0/0\"]}"
    INITIATOR_ID=$(api_call POST "iscsi/initiator" "$INITIATOR_DATA" | jq -r '.id')
fi

# 3. Target
TARGET_ID=$(api_call GET "iscsi/target" | jq -r '.[] | select(.name=="target0") | .id')
if [ -z "$TARGET_ID" ]; then
    log "Création de la target iSCSI"
    TARGET_DATA="{\"name\":\"target0\",\"alias\":\"Default\",\"groups\":[{\"portal\":$PORTAL_ID,\"initiator\":$INITIATOR_ID}]}"
    TARGET_ID=$(api_call POST "iscsi/target" "$TARGET_DATA" | jq -r '.id')
fi

# Activation du service iSCSI
api_call PUT "service/id/iscsitarget" "{\"enable\":true}"
api_call POST "service/start" '{"service":"iscsitarget"}'

# Création d'une clé API si nécessaire
if [[ "$API_KEY" == "__API_KEY__" ]]; then
    log "Création d'une clé API"
    API_KEY_DATA="{\"name\":\"${STORAGE_NODE_NAME}-key\",\"scope\":\"FULL\"}"
    API_KEY=$(api_call POST "api_key" "$API_KEY_DATA" | jq -r '.key')
else
    log "Utilisation de la clé API configurée"
fi

# Sauvegarde des informations
INFO_FILE="/tmp/truenas-info.txt"
cat > "$INFO_FILE" << EOF
TrueNAS Scale - Informations de configuration
=============================================
Date: $(date)

Accès:
-----
IP: $STORAGE_IP
Admin: admin / $ADMIN_PASSWORD
API Key: $API_KEY

Services:
--------
NFS: $STORAGE_IP:/mnt/data/shares
iSCSI Target: iqn.2005-10.org.freenas.ctl:target0

Interface web: https://$STORAGE_IP
EOF

chmod 600 "$INFO_FILE"
log "Configuration terminée. Informations sauvegardées dans $INFO_FILE"
