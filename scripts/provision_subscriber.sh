#!/usr/bin/env bash
# ==============================================================================
# File: /usr/local/bin/provision_subscriber.sh
# Purpose: Dynamically updates a subscriber's bandwidth rate-limit and VLAN ID
#          in FreeRADIUS on RHEL and dispatches an RFC 5176 CoA packet.
# Usage:   sudo /usr/local/bin/provision_subscriber.sh <USERNAME> <RATE_LIMIT> <VLAN_ID> [NAS_IP] [NAS_SECRET]
# ==============================================================================

set -euo pipefail

if [ "$#" -lt 3 ]; then
    echo "ERROR: Missing required arguments." >&2
    echo "Usage: $0 <USERNAME> <RATE_LIMIT> <VLAN_ID> [NAS_IP] [NAS_SECRET]" >&2
    exit 1
fi

USERNAME="$1"
RATE_LIMIT="$2"               # Format: 50M/50M
VLAN_ID="$3"                  # Format: 200
NAS_IP="${4:-127.0.0.1}"      # Default to localhost if no BNG/NAS IP passed
NAS_SECRET="${5:-testing123}" # Default FreeRADIUS shared secret

AUTH_FILE="/etc/raddb/mods-config/files/authorize"
LOG_DIR="/var/log/radius"
LOG_FILE="${LOG_DIR}/provisioning.log"

# 1. Strict Input Validation (Defense-in-Depth against command/sed injection)
if [[ ! "$USERNAME" =~ ^[a-zA-Z0-9_:-]+$ ]]; then
    echo "ERROR: Invalid USERNAME format: ${USERNAME}" >&2
    exit 2
fi

if [[ ! "$RATE_LIMIT" =~ ^[0-9]+[kKmMgG]/[0-9]+[kKmMgG]$ ]]; then
    echo "ERROR: Invalid RATE_LIMIT format: ${RATE_LIMIT} (Expected e.g. 50M/50M)" >&2
    exit 2
fi

if [[ ! "$VLAN_ID" =~ ^[0-9]+$ ]] || [ "$VLAN_ID" -lt 1 ] || [ "$VLAN_ID" -gt 4094 ]; then
    echo "ERROR: Invalid VLAN_ID: ${VLAN_ID} (Expected 1-4094)" >&2
    exit 2
fi

# 2. Verify the authorize file and subscriber stanza exist
if [ ! -f "$AUTH_FILE" ]; then
    echo "ERROR: FreeRADIUS authorize file not found at ${AUTH_FILE}" >&2
    exit 3
fi

if ! grep -q "^\"${USERNAME}\"" "$AUTH_FILE"; then
    echo "ERROR: Subscriber '${USERNAME}' not found in ${AUTH_FILE}" >&2
    exit 4
fi

# 3. Update Mikrotik-Rate-Limit and Tunnel-Private-Group-Id in the user's stanza
sed -i "/^\"${USERNAME}\"/,/^$/ {
    s/Mikrotik-Rate-Limit = \"[^\"]*\"/Mikrotik-Rate-Limit = \"${RATE_LIMIT}\"/
    s/Tunnel-Private-Group-Id = \"[^\"]*\"/Tunnel-Private-Group-Id = \"${VLAN_ID}\"/
}" "$AUTH_FILE"

# 4. Reload FreeRADIUS daemon so new authentication requests get the new profile
systemctl reload radiusd

# 5. Prepare audit log directory and record timestamped provisioning event
mkdir -p "$LOG_DIR"
TIMESTAMP="$(date -Is)"

# 6. Dispatch RFC 5176 Change of Authorization (CoA) packet on UDP 3799
COA_STATUS="SKIPPED_NO_LISTENER"
COA_PAYLOAD=$(cat <<EOF
User-Name = "${USERNAME}"
Mikrotik-Rate-Limit = "${RATE_LIMIT}"
Tunnel-Type = VLAN
Tunnel-Medium-Type = IEEE-802
Tunnel-Private-Group-Id = "${VLAN_ID}"
EOF
)

if command -v nc >/dev/null 2>&1 && nc -uzw1 "$NAS_IP" 3799 2>/dev/null; then
    if echo "$COA_PAYLOAD" | radclient -r 1 -t 2 "${NAS_IP}:3799" coa "$NAS_SECRET" >/dev/null 2>&1; then
        COA_STATUS="COA_ACK_RECEIVED"
    else
        # In lab mode where UDP 3799 is open or simulated without a physical BNG reply
        COA_STATUS="COA_DISPATCHED_NO_ACK"
    fi
fi

echo "[${TIMESTAMP}] status=SUCCESS user=${USERNAME} rate=${RATE_LIMIT} vlan=${VLAN_ID} nas=${NAS_IP} coa=${COA_STATUS}" >> "$LOG_FILE"

# 7. Output token expected by Node.js ssh2 client
echo "PROVISION_OK"
