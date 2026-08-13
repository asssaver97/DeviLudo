#!/usr/bin/env bash
set -Eeuo pipefail
export DEVILUDO_ROLE=E2E_MACOS
source "$(cd "$(dirname "$0")/../common" && pwd)/lib.sh"
role_preflight() { [[ $(uname -m) == arm64 ]] || return 1; [[ $(sw_vers -productVersion | cut -d. -f1) -ge 15 ]] || return 1; for variable in DEVILUDO_ENROLLMENT_TOKEN_FILE DEVILUDO_GOLDEN_VM_FILE DEVILUDO_E2E_CORE_CA_FILE DEVILUDO_GUEST_SSH_KEY_FILE DEVILUDO_GUEST_KNOWN_HOSTS_FILE; do require_file "${!variable:?}"; done; require_file "$DEVILUDO_GOLDEN_VM_FILE.pem"; require_file "$DEVILUDO_GOLDEN_VM_FILE.sig"; [[ ${DEVILUDO_CORE_URL:-} == https://* ]]; }
role_bootstrap() { require_root; command -v brew >/dev/null; local brew_owner; brew_owner=$(stat -f %Su "$(brew --prefix)"); sudo -u "$brew_owner" brew install node@22 cirruslabs/cli/tart godot cosign jq; create_service_user; install -d -o deviludo-e2e -g staff "/Library/Application Support/DeviludoE2E" "/Library/Application Support/DeviludoE2E/logs" /var/lib/deviludo-e2e; }
create_service_user() {
  id deviludo-e2e >/dev/null 2>&1 && return
  local uid=499
  while dscl . -search /Users UniqueID "$uid" | grep -q .; do uid=$((uid - 1)); [[ $uid -ge 400 ]] || return 1; done
  dscl . -create /Users/deviludo-e2e
  dscl . -create /Users/deviludo-e2e UserShell /usr/bin/false
  dscl . -create /Users/deviludo-e2e RealName "Deviludo E2E Service"
  dscl . -create /Users/deviludo-e2e UniqueID "$uid"
  dscl . -create /Users/deviludo-e2e PrimaryGroupID 20
  dscl . -create /Users/deviludo-e2e NFSHomeDirectory "/Library/Application Support/DeviludoE2E"
  dscl . -create /Users/deviludo-e2e IsHidden 1
  dscl . -create /Users/deviludo-e2e AuthenticationAuthority ";DisabledUser;"
  dscl . -passwd /Users/deviludo-e2e '*'
}
role_validate_config() { role_preflight; cosign verify-blob --certificate "$DEVILUDO_GOLDEN_VM_FILE.pem" --signature "$DEVILUDO_GOLDEN_VM_FILE.sig" --certificate-identity-regexp "$DEVILUDO_COSIGN_IDENTITY_REGEXP" --certificate-oidc-issuer "$DEVILUDO_COSIGN_ISSUER" "$DEVILUDO_GOLDEN_VM_FILE" >/dev/null; }
role_install() {
  local stage=$1 base="/Library/Application Support/DeviludoE2E" credentials="/Library/Application Support/DeviludoE2E/credentials" golden_dir="/Library/Application Support/DeviludoE2E/golden" golden_vm="/Library/Application Support/DeviludoE2E/golden/macos-golden.tvm"
  [[ "sha256:$(shasum -a 256 "$DEVILUDO_GOLDEN_VM_FILE" | cut -d' ' -f1)" == "$(jq -r '.e2eRuntimeDigests.macos' "$stage/release-manifest.json")" ]] || { log "macOS golden VM digest mismatch"; return 1; }
  install -d -m 0700 -o deviludo-e2e -g staff "$credentials" "$base/jobs" "$golden_dir"
  install -m 0400 -o deviludo-e2e -g staff "$DEVILUDO_GOLDEN_VM_FILE" "$golden_vm"
  install -m 0400 -o deviludo-e2e -g staff "$DEVILUDO_GOLDEN_VM_FILE.pem" "$golden_vm.pem"
  install -m 0400 -o deviludo-e2e -g staff "$DEVILUDO_GOLDEN_VM_FILE.sig" "$golden_vm.sig"
  install -m 0600 -o deviludo-e2e -g staff "$DEVILUDO_GUEST_SSH_KEY_FILE" "$base/guest_ed25519"
  install -m 0644 "$DEVILUDO_GUEST_KNOWN_HOSTS_FILE" "$base/guest_known_hosts"
  if ! sudo -u deviludo-e2e -H /opt/homebrew/bin/tart list | awk '{print $1}' | grep -qx "$DEVILUDO_GOLDEN_VM_NAME"; then sudo -u deviludo-e2e -H /opt/homebrew/bin/tart import "$DEVILUDO_GOLDEN_VM_NAME" "$golden_vm"; fi
  if [[ ! -s $credentials/node-id ]]; then
    DEVILUDO_CORE_API_URL="$DEVILUDO_CORE_URL" DEVILUDO_ENROLLMENT_TOKEN_FILE="$DEVILUDO_ENROLLMENT_TOKEN_FILE" DEVILUDO_E2E_CORE_CA_FILE="$DEVILUDO_E2E_CORE_CA_FILE" DEVILUDO_E2E_CREDENTIAL_DIRECTORY="$credentials" DEVILUDO_E2E_POOL_KIND=E2E_MACOS DEVILUDO_E2E_OPERATING_SYSTEM=macos /opt/homebrew/bin/node "$stage/e2e-enroll.mjs"
    chown -R deviludo-e2e:staff "$credentials"
  fi
  local node_id; node_id=$(<"$credentials/node-id")
  cat > "$base/node.env" <<EOF
NODE_ENV=production
HOME="$base"
DEVILUDO_E2E_NODE_ID=$node_id
DEVILUDO_E2E_POOL_KIND=E2E_MACOS
DEVILUDO_CORE_API_URL=$DEVILUDO_CORE_URL
DEVILUDO_E2E_CLIENT_CERT_FILE="$credentials/node.crt"
DEVILUDO_E2E_CLIENT_KEY_FILE="$credentials/node-tls.key"
DEVILUDO_E2E_CORE_CA_FILE="$credentials/core-ca.crt"
DEVILUDO_E2E_IDENTITY_KEY_FILE="$credentials/receipt-ed25519.pem"
DEVILUDO_E2E_CREDENTIAL_DIRECTORY="$credentials"
DEVILUDO_NODE_BIN=/opt/homebrew/bin/node
DEVILUDO_E2E_TOOL_PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
DEVILUDO_E2E_ISOLATION_EXECUTOR=/opt/deviludo/current/e2e-macos-isolation.sh
DEVILUDO_E2E_TEST_EXECUTOR=/opt/deviludo/current/e2e-job-executor.mjs
DEVILUDO_E2E_GUEST_RUNNER=/opt/deviludo/current/e2e-macos-guest-runner.sh
DEVILUDO_E2E_JOB_ROOT="$base/jobs"
DEVILUDO_GOLDEN_VM_FILE="$golden_vm"
DEVILUDO_GOLDEN_VM_NAME="$DEVILUDO_GOLDEN_VM_NAME"
DEVILUDO_COSIGN_IDENTITY_REGEXP=$DEVILUDO_COSIGN_IDENTITY_REGEXP
DEVILUDO_COSIGN_ISSUER=$DEVILUDO_COSIGN_ISSUER
EOF
  chmod 0600 "$base/node.env"; chown deviludo-e2e:staff "$base/node.env"
  install -m 0644 "$stage/com.deviludo.e2e.plist" /Library/LaunchDaemons/com.deviludo.e2e.plist
  install -m 0644 "$stage/com.deviludo.e2e-renew.plist" /Library/LaunchDaemons/com.deviludo.e2e-renew.plist
}
role_restart() { launchctl bootout system/com.deviludo.e2e 2>/dev/null || true; launchctl bootout system/com.deviludo.e2e-renew 2>/dev/null || true; launchctl bootstrap system /Library/LaunchDaemons/com.deviludo.e2e.plist; launchctl bootstrap system /Library/LaunchDaemons/com.deviludo.e2e-renew.plist; }
role_healthcheck() { /opt/deviludo/current/deviludo-e2e-host preflight --pool E2E_MACOS --isolation tart; }
role_stop() { launchctl bootout system/com.deviludo.e2e 2>/dev/null || true; launchctl bootout system/com.deviludo.e2e-renew 2>/dev/null || true; }
role_status() { launchctl print system/com.deviludo.e2e; }
dispatch "$@"
