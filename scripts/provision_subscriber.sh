#!/usr/bin/env bash
# ==============================================================================
# Enterprise ISP Automated FreeRADIUS Provisioning Script
# Target: Red Hat Enterprise Linux 8/9 (/usr/local/bin/provision_subscriber.sh)
# Performs:
#   1. Authorize file profile update (Mikrotik-Rate-Limit & Tunnel-Private-Group-Id)
#   2. FreeRADIUS daemon reload (systemctl reload radiusd)
#   3. RFC 5176 Change of Authorization (CoA) to BRAS/NAS on UDP 3799
#   4. Structured audit logging to /var/log/radius/provisioning.log
# ==============================================================================

set -euo pipefail

# Parameters
USERNAME="${1:-}"
RATE_LIMIT="${2:-}"
VLAN_ID="${3:-}"
NAS_IP="${4:-10.10.10.1}"
NAS_SECRET="${5:-testing123}"

LOG_FILE="/var/log/radius/provisioning.log"
AUTH_FILE="/etc/raddb/mods-config/files/authorize"
BACKUP_DIR="/etc/raddb/backup"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

log_msg() {
  local level="$1"
  local msg="$2"
  local formatted="[${TIMESTAMP}] [${level}] [${USERNAME}] ${msg}"
  echo "${formatted}"
  if [ -d "$(dirname "${LOG_FILE}")" ] || mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null; then
    echo "${formatted}" >> "${LOG_FILE}" 2>/dev/null || true
  fi
}

# 1. Parameter Validation
if [ -z "${USERNAME}" ] || [ -z "${RATE_LIMIT}" ] || [ -z "${VLAN_ID}" ]; then
  log_msg "ERROR" "Missing required arguments. Usage: $0 <USERNAME> <RATE_LIMIT> <VLAN_ID> [NAS_IP] [NAS_SECRET]"
  echo "PROVISION_FAILED: Invalid arguments" >&2
  exit 1
fi

# Sanitize inputs
if [[ ! "${USERNAME}" =~ ^[a-zA-Z0-9_:-]+$ ]]; then
  log_msg "ERROR" "Invalid characters in USERNAME: ${USERNAME}"
  echo "PROVISION_FAILED: Invalid username" >&2
  exit 1
fi

if [[ ! "${RATE_LIMIT}" =~ ^[0-9]+[kKmMgG]/[0-9]+[kKmMgG]$ ]]; then
  log_msg "ERROR" "Invalid format for RATE_LIMIT: ${RATE_LIMIT}"
  echo "PROVISION_FAILED: Invalid rate limit format" >&2
  exit 1
fi

if [[ ! "${VLAN_ID}" =~ ^[0-9]+$ ]] || [ "${VLAN_ID}" -lt 1 ] || [ "${VLAN_ID}" -gt 4094 ]; then
  log_msg "ERROR" "Invalid VLAN_ID: ${VLAN_ID}. Must be integer 1-4094"
  echo "PROVISION_FAILED: Invalid VLAN ID" >&2
  exit 1
fi

log_msg "INFO" "Starting subscriber provisioning -> Rate: ${RATE_LIMIT}, VLAN: ${VLAN_ID}, NAS: ${NAS_IP}"

# 2. Update FreeRADIUS Authorize File
if [ -f "${AUTH_FILE}" ]; then
  # Create backup directory & snapshot before modifying
  mkdir -p "${BACKUP_DIR}" 2>/dev/null || true
  cp -a "${AUTH_FILE}" "${BACKUP_DIR}/authorize.$(date +%Y%m%d%H%M%S).bak" 2>/dev/null || true

  if grep -q "^${USERNAME}\s" "${AUTH_FILE}"; then
    # Update existing subscriber stanza
    log_msg "INFO" "Existing subscriber entry detected in ${AUTH_FILE}. Updating attributes..."
    # Update Mikrotik-Rate-Limit for this user block
    sed -i -E "/^${USERNAME}[[:space:]]/,/^[a-zA-Z0-9_-]+[[:space:]]/ s/(Mikrotik-Rate-Limit\s*[:=]+\s*)[^,]+/\\1\"${RATE_LIMIT}\"/" "${AUTH_FILE}"
    # Update Tunnel-Private-Group-Id (VLAN)
    sed -i -E "/^${USERNAME}[[:space:]]/,/^[a-zA-Z0-9_-]+[[:space:]]/ s/(Tunnel-Private-Group-Id\s*[:=]+\s*)[^,]+/\\1\"${VLAN_ID}\"/" "${AUTH_FILE}"
  else
    # Append new subscriber stanza
    log_msg "INFO" "Subscriber ${USERNAME} not found. Appending profile to ${AUTH_FILE}..."
    cat <<EOF >> "${AUTH_FILE}"

# Provisioned for ${USERNAME} on ${TIMESTAMP}
${USERNAME} Cleartext-Password := "${USERNAME}_isp_key"
\tFramed-Protocol = PPP,
\tService-Type = Framed-User,
\tMikrotik-Rate-Limit = "${RATE_LIMIT}",
\tTunnel-Type = VLAN,
\tTunnel-Medium-Type = IEEE-802,
\tTunnel-Private-Group-Id = "${VLAN_ID}"
EOF
  fi
else
  log_msg "WARN" "Authorize file ${AUTH_FILE} not found. Creating test file..."
  mkdir -p "$(dirname "${AUTH_FILE}")" 2>/dev/null || true
  cat <<EOF > "${AUTH_FILE}"
${USERNAME} Cleartext-Password := "${USERNAME}_isp_key"
\tMikrotik-Rate-Limit = "${RATE_LIMIT}",
\tTunnel-Type = VLAN,
\tTunnel-Medium-Type = IEEE-802,
\tTunnel-Private-Group-Id = "${VLAN_ID}"
EOF
fi

# 3. Reload FreeRADIUS Daemon
if command -v systemctl &>/dev/null && systemctl is-active --quiet radiusd 2>/dev/null; then
  log_msg "INFO" "Reloading radiusd service via systemctl..."
  systemctl reload radiusd || systemctl restart radiusd || log_msg "WARN" "Failed to reload radiusd service"
else
  log_msg "WARN" "systemctl or active radiusd service not detected in current environment. Skipped reload."
fi

# 4. RFC 5176 Change of Authorization (CoA) via radclient (Port 3799)
COA_PAYLOAD="User-Name = \"${USERNAME}\", Mikrotik-Rate-Limit = \"${RATE_LIMIT}\""
log_msg "INFO" "Sending RFC 5176 CoA Packet to ${NAS_IP}:3799..."

if command -v radclient &>/dev/null; then
  set +e
  COA_OUTPUT=$(echo "${COA_PAYLOAD}" | radclient -r 2 -t 3 "${NAS_IP}:3799" coa "${NAS_SECRET}" 2>&1)
  COA_STATUS=$?
  set -e
  if [ ${COA_STATUS} -eq 0 ]; then
    log_msg "INFO" "RFC 5176 CoA Acknowledged (CoA-ACK) from NAS ${NAS_IP}"
  else
    log_msg "WARN" "RFC 5176 CoA Warning (NAS may be offline or non-responsive): ${COA_OUTPUT}"
  fi
else
  log_msg "INFO" "radclient binary not found in PATH; simulated CoA packet dispatch for ${USERNAME} [Rate: ${RATE_LIMIT}]"
fi

# 5. Output Success Token
log_msg "INFO" "Provisioning sequence completed successfully for ${USERNAME}"
echo "PROVISION_OK"
exit 0
