#!/usr/bin/env bash
set -Eeuo pipefail
DEVILUDO_ROLE=E2E_LINUX
source "$(cd "$(dirname "$0")/../common" && pwd)/lib.sh"
role_preflight() { [[ $(uname -m) == x86_64 ]] || return 1; for variable in DEVILUDO_ENROLLMENT_TOKEN_FILE DEVILUDO_GOLDEN_VM_FILE DEVILUDO_E2E_CORE_CA_FILE DEVILUDO_GUEST_SSH_KEY_FILE DEVILUDO_GUEST_KNOWN_HOSTS_FILE; do require_file "${!variable:?}"; done; require_file "$DEVILUDO_GOLDEN_VM_FILE.pem"; require_file "$DEVILUDO_GOLDEN_VM_FILE.sig"; [[ ${DEVILUDO_CORE_URL:-} == https://* ]]; }
role_bootstrap() { require_root; . /etc/os-release; [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]]; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y qemu-kvm libvirt-daemon-system libvirt-clients virtinst libguestfs-tools ovmf godot openssh-client jq curl ca-certificates xz-utils ufw; install_node_linux; install_cosign_linux; useradd --system --home /var/lib/deviludo-e2e --shell /usr/sbin/nologin deviludo-e2e 2>/dev/null || true; usermod -aG libvirt,kvm deviludo-e2e; install -d -o deviludo-e2e -g deviludo-e2e /etc/deviludo/e2e /var/lib/deviludo-e2e /var/lib/deviludo-e2e/jobs; configure_ufw; systemctl enable --now libvirtd; }
role_validate_config() { role_preflight; cosign verify-blob --certificate "$DEVILUDO_GOLDEN_VM_FILE.pem" --signature "$DEVILUDO_GOLDEN_VM_FILE.sig" --certificate-identity-regexp "$DEVILUDO_COSIGN_IDENTITY_REGEXP" --certificate-oidc-issuer "$DEVILUDO_COSIGN_ISSUER" "$DEVILUDO_GOLDEN_VM_FILE" >/dev/null; }
role_install() {
  local stage=$1 credentials=/var/lib/deviludo-e2e/credentials golden_dir=/var/lib/deviludo-e2e/golden golden_vm=/var/lib/deviludo-e2e/golden/linux-golden.qcow2
  [[ "sha256:$(sha256sum "$DEVILUDO_GOLDEN_VM_FILE" | cut -d' ' -f1)" == "$(jq -r '.e2eRuntimeDigests.linux' "$stage/release-manifest.json")" ]] || { log "Linux golden VM digest mismatch"; return 1; }
  install -d -m 0700 -o deviludo-e2e -g deviludo-e2e "$credentials" "$golden_dir"
  install -m 0400 -o deviludo-e2e -g deviludo-e2e "$DEVILUDO_GOLDEN_VM_FILE" "$golden_vm"
  install -m 0400 -o deviludo-e2e -g deviludo-e2e "$DEVILUDO_GOLDEN_VM_FILE.pem" "$golden_vm.pem"
  install -m 0400 -o deviludo-e2e -g deviludo-e2e "$DEVILUDO_GOLDEN_VM_FILE.sig" "$golden_vm.sig"
  install -m 0600 -o deviludo-e2e -g deviludo-e2e "$DEVILUDO_GUEST_SSH_KEY_FILE" /etc/deviludo/e2e/guest_ed25519
  install -m 0644 "$DEVILUDO_GUEST_KNOWN_HOSTS_FILE" /etc/deviludo/e2e/guest_known_hosts
  if [[ ! -s $credentials/node-id ]]; then
    DEVILUDO_CORE_API_URL="$DEVILUDO_CORE_URL" DEVILUDO_ENROLLMENT_TOKEN_FILE="$DEVILUDO_ENROLLMENT_TOKEN_FILE" DEVILUDO_E2E_CORE_CA_FILE="$DEVILUDO_E2E_CORE_CA_FILE" DEVILUDO_E2E_CREDENTIAL_DIRECTORY="$credentials" DEVILUDO_E2E_POOL_KIND=E2E_LINUX DEVILUDO_E2E_OPERATING_SYSTEM=linux node "$stage/e2e-enroll.mjs"
    chown -R deviludo-e2e:deviludo-e2e "$credentials"
  fi
  local node_id; node_id=$(<"$credentials/node-id")
  cat > /etc/deviludo/e2e/node.env <<EOF
NODE_ENV=production
DEVILUDO_E2E_NODE_ID=$node_id
DEVILUDO_E2E_POOL_KIND=E2E_LINUX
DEVILUDO_CORE_API_URL=$DEVILUDO_CORE_URL
DEVILUDO_E2E_CLIENT_CERT_FILE=$credentials/node.crt
DEVILUDO_E2E_CLIENT_KEY_FILE=$credentials/node-tls.key
DEVILUDO_E2E_CORE_CA_FILE=$credentials/core-ca.crt
DEVILUDO_E2E_IDENTITY_KEY_FILE=$credentials/receipt-ed25519.pem
DEVILUDO_E2E_CREDENTIAL_DIRECTORY=$credentials
DEVILUDO_NODE_BIN=/usr/local/bin/node
DEVILUDO_E2E_TOOL_PATH=/usr/local/bin:/usr/bin:/bin
DEVILUDO_E2E_ISOLATION_EXECUTOR=/opt/deviludo/current/e2e-linux-isolation.sh
DEVILUDO_E2E_TEST_EXECUTOR=/opt/deviludo/current/e2e-job-executor.mjs
DEVILUDO_E2E_GUEST_RUNNER=/opt/deviludo/current/e2e-linux-guest-runner.sh
DEVILUDO_E2E_JOB_ROOT=/var/lib/deviludo-e2e/jobs
DEVILUDO_GOLDEN_VM_FILE=$golden_vm
DEVILUDO_COSIGN_IDENTITY_REGEXP=$DEVILUDO_COSIGN_IDENTITY_REGEXP
DEVILUDO_COSIGN_ISSUER=$DEVILUDO_COSIGN_ISSUER
EOF
  chown deviludo-e2e:deviludo-e2e /etc/deviludo/e2e/node.env
  chmod 0600 /etc/deviludo/e2e/node.env
  install -m 0644 "$stage/deviludo-e2e.service" /etc/systemd/system/deviludo-e2e.service
  install -m 0644 "$stage/deviludo-e2e-renew.service" /etc/systemd/system/deviludo-e2e-renew.service
  install -m 0644 "$stage/deviludo-e2e-renew.timer" /etc/systemd/system/deviludo-e2e-renew.timer
  systemctl daemon-reload
}
role_restart() { systemctl enable --now deviludo-e2e deviludo-e2e-renew.timer; }
role_healthcheck() { /opt/deviludo/current/deviludo-e2e-host preflight --pool E2E_LINUX; }
role_stop() { systemctl stop deviludo-e2e deviludo-e2e-renew.timer || true; }
role_status() { systemctl --no-pager status deviludo-e2e; }
dispatch "$@"
