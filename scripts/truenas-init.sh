#!/bin/bash
# TrueNAS Scale Initialization Script
# This script will run on first boot to configure TrueNAS

# Enable strict mode
set -euo pipefail

# Configuration variables that will be replaced by run.js
ADMIN_PASSWORD="__ADMIN_PASSWORD__"
ADMIN_EMAIL="__ADMIN_EMAIL__"
STORAGE_NODE_NAME="__STORAGE_NODE_NAME__"
API_KEY="__API_KEY__"
STORAGE_IP="__STORAGE_IP__"

# Log all output
exec > /tmp/truenas-init.log 2>&1

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting TrueNAS Scale initialization script"

# Wait for TrueNAS API to be available
MAX_RETRIES=30
RETRY_INTERVAL=10
ATTEMPTS=0

log "Waiting for TrueNAS API to be accessible..."
while [ $ATTEMPTS -lt $MAX_RETRIES ]; do
    if curl -s -k https://localhost/api/v2.0 > /dev/null; then
        log "TrueNAS API is accessible"
        break
    fi
    
    ATTEMPTS=$((ATTEMPTS + 1))
    log "Attempt $ATTEMPTS: TrueNAS API not yet accessible, waiting ${RETRY_INTERVAL}s..."
    sleep $RETRY_INTERVAL
done

if [ $ATTEMPTS -eq $MAX_RETRIES ]; then
    log "ERROR: TrueNAS API not accessible after $MAX_RETRIES attempts. Exiting."
    exit 1
fi

# Get auth token - first try with default 'admin' credentials
log "Getting authentication token..."
TOKEN=$(curl -s -k -X POST \
    -H "Content-Type: application/json" \
    -d '{"username": "admin", "password": "admin"}' \
    https://localhost/api/v2.0/auth/token | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# If default credentials fail, try with the configured password
if [ -z "$TOKEN" ]; then
    log "Default credentials failed, trying with configured password..."
    TOKEN=$(curl -s -k -X POST \
        -H "Content-Type: application/json" \
        -d "{\"username\": \"admin\", \"password\": \"$ADMIN_PASSWORD\"}" \
        https://localhost/api/v2.0/auth/token | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
fi

if [ -z "$TOKEN" ]; then
    log "ERROR: Failed to get authentication token"
    exit 1
fi

log "Authentication token obtained successfully"

# Function to make API calls
api_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    
    if [ -z "$data" ]; then
        curl -s -k -X $method \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            https://localhost/api/v2.0/$endpoint
    else
        curl -s -k -X $method \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $TOKEN" \
            -d "$data" \
            https://localhost/api/v2.0/$endpoint
    fi
}

# Update admin user password if using default
if [[ "$ADMIN_PASSWORD" != "admin" && "$ADMIN_PASSWORD" != "__ADMIN_PASSWORD__" ]]; then
    log "Updating admin user password..."
    USER_DATA=$(api_call GET "user" | jq '.[] | select(.username=="admin")')
    USER_ID=$(echo "$USER_DATA" | jq -r '.id')
    
    if [ -n "$USER_ID" ]; then
        PASSWORD_UPDATE=$(api_call PUT "user/id/$USER_ID" "{
            \"password\": \"$ADMIN_PASSWORD\"
        }")
        log "Admin password updated"
    else
        log "Could not find admin user ID"
    fi
fi

# Check if data disk is attached and identify it
log "Detecting data disk..."
DATA_DISK=$(ls -l /dev/disk/by-path/ | grep -v part | grep sdb | head -1 | awk '{print $NF}' | xargs basename)

if [ -z "$DATA_DISK" ]; then
    log "WARNING: Data disk not found via disk-by-path. Trying direct device detection..."
    # Check for sdb
    if [ -e "/dev/sdb" ]; then
        DATA_DISK="sdb"
    else
        # Find disks that aren't used as the boot disk
        AVAILABLE_DISKS=$(lsblk -d -n -o NAME,MOUNTPOINT | grep -v -E "^([hsv]d[a])|.*/$" | awk '{print $1}')
        DATA_DISK=$(echo "$AVAILABLE_DISKS" | head -1)
    fi
fi

if [ -z "$DATA_DISK" ]; then
    log "ERROR: No data disk found. Cannot continue."
    exit 1
fi

DATA_DISK_PATH="/dev/$DATA_DISK"
log "Data disk identified as $DATA_DISK_PATH"

# Check if any pools already exist
log "Checking for existing ZFS pools..."
EXISTING_POOLS=$(api_call GET "pool")
if [[ "$EXISTING_POOLS" == "[]" ]]; then
    # Create a ZFS pool on the data disk
    log "Creating ZFS pool 'data' on $DATA_DISK_PATH"
    POOL_DATA='{
        "name": "data",
        "topology": {
            "data": [
                {
                    "type": "STRIPE",
                    "disks": ["'$DATA_DISK_PATH'"]
                }
            ]
        }
    }'
    
    POOL_RESULT=$(api_call POST "pool" "$POOL_DATA")
    log "Pool creation result: $POOL_RESULT"
    
    # Wait for pool to be imported
    sleep 5
else
    log "Pools already exist. Skipping pool creation."
fi

# Create datasets if they don't exist
log "Creating datasets structure..."
DATASETS=(
    "data/shares"
    "data/iscsi"
    "data/backup"
    "data/s3"
)

for ds in "${DATASETS[@]}"; do
    # Check if dataset exists
    DS_CHECK=$(api_call GET "pool/dataset" | jq -r '.[] | select(.name=="'$ds'") | .name')
    
    if [ -z "$DS_CHECK" ]; then
        log "Creating dataset $ds"
        DS_DATA='{
            "name": "'$ds'",
            "type": "FILESYSTEM",
            "sync": "STANDARD",
            "compression": "LZ4"
        }'
        
        DS_RESULT=$(api_call POST "pool/dataset" "$DS_DATA")
        log "Dataset creation result for $ds: $DS_RESULT"
    else
        log "Dataset $ds already exists. Skipping."
    fi
done

# Configure SMB share if not already set up
log "Configuring SMB share..."
SMB_CHECK=$(api_call GET "sharing/smb" | jq -r '.[] | select(.name=="shared") | .name')

if [ -z "$SMB_CHECK" ]; then
    SMB_DATA='{
        "name": "shared",
        "path": "/mnt/data/shares",
        "purpose": "STANDARD_SHARE",
        "path_suffix": "",
        "home": false,
        "enabled": true
    }'
    
    SMB_RESULT=$(api_call POST "sharing/smb" "$SMB_DATA")
    log "SMB share creation result: $SMB_RESULT"
else
    log "SMB share 'shared' already exists. Skipping."
fi

# Enable SMB service
log "Enabling SMB service..."
SMB_SERVICE_DATA='{
    "enable": true
}'

SMB_SERVICE_RESULT=$(api_call PUT "service/id/cifs" "$SMB_SERVICE_DATA")
log "SMB service enabling result: $SMB_SERVICE_RESULT"
api_call POST "service/start" '{"service": "cifs"}'

# Configure NFS share if not already set up
log "Configuring NFS share..."
NFS_CHECK=$(api_call GET "sharing/nfs" | jq -r '.[] | select(.paths[0]=="/mnt/data/shares") | .paths[0]')

if [ -z "$NFS_CHECK" ]; then
    NFS_DATA='{
        "paths": ["/mnt/data/shares"],
        "enabled": true,
        "networks": [],
        "hosts": [],
        "security": ["SYS"]
    }'
    
    NFS_RESULT=$(api_call POST "sharing/nfs" "$NFS_DATA")
    log "NFS share creation result: $NFS_RESULT"
else
    log "NFS share for /mnt/data/shares already exists. Skipping."
fi

# Enable NFS service
log "Enabling NFS service..."
NFS_SERVICE_DATA='{
    "enable": true
}'

NFS_SERVICE_RESULT=$(api_call PUT "service/id/nfs" "$NFS_SERVICE_DATA")
log "NFS service enabling result: $NFS_SERVICE_RESULT"
api_call POST "service/start" '{"service": "nfs"}'

# Set up iSCSI service
log "Setting up iSCSI service..."

# Create iSCSI Portal if it doesn't exist
PORTAL_CHECK=$(api_call GET "iscsi/portal" | jq -r '.[] | select(.comment=="Default Portal") | .id')

if [ -z "$PORTAL_CHECK" ]; then
    log "Creating iSCSI Portal"
    PORTAL_DATA='{
        "comment": "Default Portal",
        "listen": [{"ip": "0.0.0.0", "port": 3260}],
        "discovery_authmethod": "NONE"
    }'
    
    PORTAL_RESULT=$(api_call POST "iscsi/portal" "$PORTAL_DATA")
    log "iSCSI Portal creation result: $PORTAL_RESULT"
    PORTAL_ID=$(echo "$PORTAL_RESULT" | jq -r '.id')
else
    PORTAL_ID=$PORTAL_CHECK
    log "iSCSI Portal already exists with ID: $PORTAL_ID"
fi

# Create iSCSI Initiator Group if it doesn't exist
INITIATOR_CHECK=$(api_call GET "iscsi/initiator" | jq -r '.[] | select(.comment=="Default Initiator Group") | .id')

if [ -z "$INITIATOR_CHECK" ]; then
    log "Creating iSCSI Initiator Group"
    INITIATOR_DATA='{
        "comment": "Default Initiator Group",
        "initiators": [],
        "auth_network": ["0.0.0.0/0"]
    }'
    
    INITIATOR_RESULT=$(api_call POST "iscsi/initiator" "$INITIATOR_DATA")
    log "iSCSI Initiator Group creation result: $INITIATOR_RESULT"
    INITIATOR_ID=$(echo "$INITIATOR_RESULT" | jq -r '.id')
else
    INITIATOR_ID=$INITIATOR_CHECK
    log "iSCSI Initiator Group already exists with ID: $INITIATOR_ID"
fi

# Create iSCSI Target if it doesn't exist
TARGET_CHECK=$(api_call GET "iscsi/target" | jq -r '.[] | select(.name=="target0") | .id')

if [ -z "$TARGET_CHECK" ]; then
    log "Creating iSCSI Target"
    TARGET_DATA='{
        "name": "target0",
        "alias": "General Purpose iSCSI Target",
        "groups": [{"portal": '$PORTAL_ID', "initiator": '$INITIATOR_ID', "auth": null}]
    }'
    
    TARGET_RESULT=$(api_call POST "iscsi/target" "$TARGET_DATA")
    log "iSCSI Target creation result: $TARGET_RESULT"
    TARGET_ID=$(echo "$TARGET_RESULT" | jq -r '.id')
else
    TARGET_ID=$TARGET_CHECK
    log "iSCSI Target already exists with ID: $TARGET_ID"
fi

# Create iSCSI Extent if it doesn't exist
EXTENT_CHECK=$(api_call GET "iscsi/extent" | jq -r '.[] | select(.name=="extent0") | .id')

if [ -z "$EXTENT_CHECK" ]; then
    # Ensure the directory exists
    mkdir -p /mnt/data/iscsi
    
    log "Creating iSCSI Extent"
    EXTENT_DATA='{
        "name": "extent0",
        "type": "FILE",
        "filesize": 10737418240,
        "path": "/mnt/data/iscsi/extent0",
        "comment": "Default Extent"
    }'
    
    EXTENT_RESULT=$(api_call POST "iscsi/extent" "$EXTENT_DATA")
    log "iSCSI Extent creation result: $EXTENT_RESULT"
    EXTENT_ID=$(echo "$EXTENT_RESULT" | jq -r '.id')
else
    EXTENT_ID=$EXTENT_CHECK
    log "iSCSI Extent already exists with ID: $EXTENT_ID"
fi

# Create iSCSI Target-Extent Association if it doesn't exist
TARGETEXTENT_CHECK=$(api_call GET "iscsi/targetextent" | jq -r '.[] | select(.target=='$TARGET_ID' and .extent=='$EXTENT_ID') | .id')

if [ -z "$TARGETEXTENT_CHECK" ]; then
    log "Creating iSCSI Target-Extent Association"
    TARGETEXTENT_DATA='{
        "target": '$TARGET_ID',
        "extent": '$EXTENT_ID',
        "lunid": 0
    }'
    
    TARGETEXTENT_RESULT=$(api_call POST "iscsi/targetextent" "$TARGETEXTENT_DATA")
    log "iSCSI Target-Extent Association result: $TARGETEXTENT_RESULT"
else
    log "iSCSI Target-Extent Association already exists"
fi

# Enable iSCSI service
log "Enabling iSCSI service"
ISCSI_SERVICE_DATA='{
    "enable": true
}'

ISCSI_SERVICE_RESULT=$(api_call PUT "service/id/iscsitarget" "$ISCSI_SERVICE_DATA")
log "iSCSI service enabling result: $ISCSI_SERVICE_RESULT"
api_call POST "service/start" '{"service": "iscsitarget"}'

# Set up S3-compatible object storage
log "Setting up S3-compatible object storage"
S3_CHECK=$(api_call GET "s3" | jq -r '.[] | .id')

if [ -z "$S3_CHECK" ]; then
    S3_SERVICE_DATA='{
        "bindip": "0.0.0.0",
        "bindport": 9000,
        "access_key": "minio",
        "secret_key": "minio123",
        "browser": true,
        "certificate": null,
        "path": "/mnt/data/s3",
        "disks": []
    }'
    
    S3_SERVICE_RESULT=$(api_call POST "s3" "$S3_SERVICE_DATA")
    log "S3 service creation result: $S3_SERVICE_RESULT"
else
    log "S3 service already exists"
fi

# Enable S3 service
log "Enabling S3 service"
S3_ENABLE_DATA='{
    "enable": true
}'

S3_ENABLE_RESULT=$(api_call PUT "service/id/s3" "$S3_ENABLE_DATA")
log "S3 service enabling result: $S3_ENABLE_RESULT"
api_call POST "service/start" '{"service": "s3"}'

# Create API key for external integrations if not provided in config
if [[ "$API_KEY" == "__API_KEY__" ]]; then
    log "Creating new API Key"
    API_KEY_DATA='{
        "name": "External Integration",
        "scope": "FULL"
    }'

    API_KEY_RESULT=$(api_call POST "api_key" "$API_KEY_DATA")
    log "API Key creation result: $API_KEY_RESULT"
    API_KEY=$(echo "$API_KEY_RESULT" | jq -r '.key')
else
    log "Using provided API Key from configuration"
fi

# Final system configuration
log "Configuring system settings"

# Configure GUI settings
GUI_DATA='{
    "ui_httpsport": 443,
    "ui_httpport": 80,
    "ui_httpsredirect": true
}'

GUI_RESULT=$(api_call PUT "system/general" "$GUI_DATA")
log "GUI configuration result: $GUI_RESULT"

# Save important information to a file that can be accessed later
STORAGE_INFO_FILE="/root/storage-info.txt"
# Determine server IP - use configured IP if available, otherwise detect from interface
if [[ "$STORAGE_IP" != "__STORAGE_IP__" ]]; then
    SERVER_IP="$STORAGE_IP"
else
    SERVER_IP=$(ip -4 addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -1)
fi

cat > $STORAGE_INFO_FILE << EOF
TrueNAS Scale Storage Configuration
==================================
Completed: $(date)

STORAGE SERVICES:
----------------
Server IP: $SERVER_IP
Server Name: $STORAGE_NODE_NAME
SMB Share: //$SERVER_IP/shared
NFS Share: $SERVER_IP:/mnt/data/shares
iSCSI Target: iqn.2005-10.org.freenas.ctl:target0
S3 Object Storage: http://$SERVER_IP:9000
S3 Access Key: minio
S3 Secret Key: minio123

API Access:
---------
API Key: $API_KEY

Datasets:
--------
/mnt/data/shares - General file sharing
/mnt/data/iscsi - iSCSI storage
/mnt/data/backup - Backup storage
/mnt/data/s3 - S3 object storage

Access the TrueNAS Scale web interface at:
http://$SERVER_IP or https://$SERVER_IP

EOF

chmod 600 $STORAGE_INFO_FILE
log "Configuration information saved to $STORAGE_INFO_FILE"

log "TrueNAS Scale initialization completed"
log "Storage services are now available at: http://$SERVER_IP or https://$SERVER_IP"
