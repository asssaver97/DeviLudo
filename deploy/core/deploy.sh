#!/usr/bin/env bash
set -Eeuo pipefail
DEVILUDO_ROLE=CORE
source "$(cd "$(dirname "$0")/../common" && pwd)/lib.sh"
role_preflight() { [[ $(uname -m) == x86_64 ]] || { log "CORE requires x86_64 for the Steam toolchain"; return 1; }; [[ -c /dev/kvm ]] || { log "CORE requires hardware virtualization at /dev/kvm"; return 1; }; require_command curl; require_command jq; require_command openssl; for variable in DEVILUDO_DATABASE_OWNER_URL_FILE DEVILUDO_DATABASE_API_URL_FILE DEVILUDO_DATABASE_SCHEDULER_URL_FILE DEVILUDO_DATABASE_SANDBOX_URL_FILE DEVILUDO_S3_CREDENTIALS_FILE DEVILUDO_VAULT_ADMIN_TOKEN_FILE DEVILUDO_VAULT_TOKEN_FILE DEVILUDO_VAULT_EXECUTOR_TOKEN_FILE DEVILUDO_VAULT_PKI_TOKEN_FILE DEVILUDO_TLS_CERT_FILE DEVILUDO_TLS_KEY_FILE DEVILUDO_TLS_SERVER_CA_FILE DEVILUDO_TLS_CLIENT_CA_FILE DEVILUDO_WEB_CORE_TOKEN_FILE; do require_file "${!variable:?}"; done; [[ ${DEVILUDO_ACCESS_MODE:-} != platform ]] || require_file "${DEVILUDO_PLATFORM_INTERNAL_TOKEN_FILE:?}"; }
role_bootstrap() {
  ubuntu_docker_bootstrap
  DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils
  useradd --system --uid 1001 --home /var/lib/deviludo --shell /usr/sbin/nologin deviludo 2>/dev/null || true
  useradd --system --uid 10001 --home /var/lib/deviludo-executor --shell /usr/sbin/nologin deviludo-executor 2>/dev/null || true
  install -d -m 0711 -o root -g root /etc/deviludo/core
  install -d -m 0750 -o deviludo -g deviludo /var/lib/deviludo
  install -d -m 2770 -o deviludo -g deviludo "${DEVILUDO_PROJECTS_ROOT:?}"
  install -d -m 0700 -o 10001 -g 10001 /var/lib/deviludo-executor
  configure_ufw "$DEVILUDO_CORE_BIND_ADDRESS" 8443 "${DEVILUDO_CORE_ALLOWED_CIDRS:?}"
}
role_validate_config() { role_preflight; [[ ${DEVILUDO_ACCESS_MODE:-} =~ ^(standalone|platform)$ && ${DEVILUDO_PROJECTS_ROOT:-} == /var/lib/deviludo-projects && ${DEVILUDO_S3_ENDPOINT:-} == https://* && ${DEVILUDO_S3_PUBLIC_ENDPOINT:-} == https://* && ${DEVILUDO_VAULT_ADDR:-} == https://* && ${DEVILUDO_OTEL_ENDPOINT:-} == https://* && ${DEVILUDO_PROVIDER_ALLOWLIST:-} =~ ^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$ && ${DEVILUDO_STEAM_ALLOWLIST:-} =~ ^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$ && ${DEVILUDO_CORE_BIND_ADDRESS:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && ${DEVILUDO_CORE_BIND_ADDRESS:-} != 0.0.0.0 && ${DEVILUDO_CORE_BIND_ADDRESS:-} != 127.0.0.1 && ${DEVILUDO_CORE_ALLOWED_CIDRS:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}(,([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2})*$ && ${DEVILUDO_STEAM_APP_ID:-} =~ ^[0-9]{2,12}$ && ${DEVILUDO_STEAM_DEPOT_LINUX:-} =~ ^[0-9]{2,12}$ && ${DEVILUDO_STEAM_DEPOT_WINDOWS:-} =~ ^[0-9]{2,12}$ && ${DEVILUDO_STEAM_DEPOT_MACOS:-} =~ ^[0-9]{2,12}$ ]] || return 1; [[ $DEVILUDO_ACCESS_MODE != platform || ${DEVILUDO_PLATFORM_ACCOUNT_API_URL:-} == https://* ]] || return 1; }
role_verify_images() { local image; while IFS= read -r image; do verify_and_pull_image "$image"; done < <(jq -r '.images[] | select(contains("-web@") | not)' "$1"); }
role_install() {
  local stage=$1 secrets=/etc/deviludo/core/secrets manifest="$1/release-manifest.json"
  install -d -m 0711 -o root -g root "$secrets"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_DATABASE_OWNER_URL_FILE" "$secrets/database-owner.url"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_DATABASE_API_URL_FILE" "$secrets/database-api.url"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_DATABASE_SCHEDULER_URL_FILE" "$secrets/database-scheduler.url"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_DATABASE_SANDBOX_URL_FILE" "$secrets/database-sandbox.url"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_S3_CREDENTIALS_FILE" "$secrets/s3.credentials"
  install -m 0400 -o 10001 -g 10001 "$DEVILUDO_S3_CREDENTIALS_FILE" "$secrets/executor-s3.credentials"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_VAULT_TOKEN_FILE" "$secrets/vault-api.token"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_VAULT_ADMIN_TOKEN_FILE" "$secrets/vault-admin.token"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_VAULT_EXECUTOR_TOKEN_FILE" "$secrets/vault-executor.token"
  install -m 0400 -o 10001 -g 10001 "$DEVILUDO_VAULT_EXECUTOR_TOKEN_FILE" "$secrets/executor-vault.token"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_VAULT_PKI_TOKEN_FILE" "$secrets/vault-pki.token"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_WEB_CORE_TOKEN_FILE" "$secrets/web-token"
  if [[ $DEVILUDO_ACCESS_MODE == platform ]]; then install -m 0400 -o 1001 -g 1001 "$DEVILUDO_PLATFORM_INTERNAL_TOKEN_FILE" "$secrets/platform-internal.token"; else install -m 0400 -o 1001 -g 1001 /dev/null "$secrets/platform-internal.token"; fi
  install -m 0644 "$DEVILUDO_TLS_CERT_FILE" "$secrets/core.crt"
  install -m 0400 -o 1001 -g 1001 "$DEVILUDO_TLS_KEY_FILE" "$secrets/core.key"
  install -m 0644 "$DEVILUDO_TLS_CLIENT_CA_FILE" "$secrets/e2e-ca.crt"
  [[ -f $secrets/executor-ed25519.pem ]] || openssl genpkey -algorithm Ed25519 -out "$secrets/executor-ed25519.pem"
  openssl pkey -in "$secrets/executor-ed25519.pem" -pubout -out "$secrets/executor-ed25519.pub"
  chown 10001:10001 "$secrets/executor-ed25519.pem"
  chmod 0400 "$secrets/executor-ed25519.pem"; chmod 0644 "$secrets/executor-ed25519.pub"
  mv "$stage/core.compose.yaml" "$stage/compose.yaml"
  install -m 0644 "$stage/deviludo-executord.service" /etc/systemd/system/deviludo-executord.service
  local core_image executor_image proxy_image allowed
  core_image=$(image_from_manifest "$manifest" '-core@')
  executor_image=$(image_from_manifest "$manifest" '-executor@')
  proxy_image=$(image_from_manifest "$manifest" '-provider-proxy@')
  allowed=$(jq -r '[.images[] | select(test("-(agent-claude|agent-codex|godot-builder|steam-publisher)@"))] | join(",")' "$manifest")
  local agent_smoke_image
  agent_smoke_image=$(jq -r '.images[] | select(test("-agent-claude@"))' "$manifest" | head -n 1)
  [[ -n $allowed ]] || { log "executor image allowlist is empty"; return 1; }
  [[ $agent_smoke_image == *@sha256:* ]] || { log "Agent microVM smoke image is missing"; return 1; }
  install_kata_runtime "$manifest" "$stage"
  printf 'DEVILUDO_CORE_IMAGE=%s\nDEVILUDO_PROVIDER_PROXY_IMAGE=%s\nDEVILUDO_CORE_BIND_ADDRESS=%s\nDEVILUDO_PROVIDER_ALLOWLIST=%s\nDEVILUDO_STEAM_ALLOWLIST=%s\nDEVILUDO_S3_ENDPOINT=%s\nDEVILUDO_S3_PUBLIC_ENDPOINT=%s\nDEVILUDO_S3_REGION=%s\nDEVILUDO_S3_PATH_STYLE=%s\nDEVILUDO_S3_CREATE_BUCKET=%s\nDEVILUDO_ARTIFACT_BUCKET=%s\nDEVILUDO_VAULT_ADDR=%s\nDEVILUDO_OTEL_ENDPOINT=%s\n' "$core_image" "$proxy_image" "$DEVILUDO_CORE_BIND_ADDRESS" "$DEVILUDO_PROVIDER_ALLOWLIST" "$DEVILUDO_STEAM_ALLOWLIST" "$DEVILUDO_S3_ENDPOINT" "$DEVILUDO_S3_PUBLIC_ENDPOINT" "${DEVILUDO_S3_REGION:-us-east-1}" "${DEVILUDO_S3_PATH_STYLE:-0}" "${DEVILUDO_S3_CREATE_BUCKET:-0}" "$DEVILUDO_ARTIFACT_BUCKET" "$DEVILUDO_VAULT_ADDR" "$DEVILUDO_OTEL_ENDPOINT" > "$stage/runtime.env"
  printf 'DEVILUDO_ACCESS_MODE=%s\nDEVILUDO_PLATFORM_ACCOUNT_API_URL=%s\nDEVILUDO_PROJECTS_ROOT=%s\n' "$DEVILUDO_ACCESS_MODE" "${DEVILUDO_PLATFORM_ACCOUNT_API_URL:-}" "$DEVILUDO_PROJECTS_ROOT" >> "$stage/runtime.env"
  printf 'NODE_ENV=production\nDEVILUDO_EXECUTOR_ID=core-executor\nDEVILUDO_EXECUTOR_IMAGE=%s\nDEVILUDO_EXECUTOR_ALLOWED_IMAGES=%s\nDEVILUDO_EXECUTOR_MICROVM_RUNTIME=io.containerd.kata.v2\nDEVILUDO_EXECUTOR_MICROVM_SMOKE_IMAGE=%s\nDEVILUDO_DOCKER_GID=%s\nDEVILUDO_EXECUTOR_SOCKET=/run/deviludo-executor/executor.sock\nDEVILUDO_EXECUTOR_SOCKET_GID=1001\nDEVILUDO_EXECUTOR_IDENTITY_KEY_FILE=/run/service-secrets/identity.pem\nDEVILUDO_VAULT_TOKEN_FILE=/run/service-secrets/vault.token\nAWS_SHARED_CREDENTIALS_FILE=/run/service-secrets/s3.credentials\nDEVILUDO_EXECUTOR_WORK_ROOT=/var/lib/deviludo-executor\nDEVILUDO_PROJECTS_ROOT=/var/lib/deviludo-projects\nDEVILUDO_EXECUTOR_SECRET_ROOT=/run/deviludo-secrets\nDEVILUDO_EXECUTOR_AGENT_NETWORK=deviludo-executor-agent\nDEVILUDO_EXECUTOR_STEAM_NETWORK=deviludo-executor-steam\nDEVILUDO_EXECUTOR_EGRESS_PROXY=http://provider-proxy:3128\nDEVILUDO_EXECUTOR_STEAM_PROXY=http://steam-proxy:3128\nDEVILUDO_PROVIDER_ALLOWLIST=%s\nDEVILUDO_VAULT_ADDR=%s\nDEVILUDO_S3_ENDPOINT=%s\nDEVILUDO_S3_REGION=%s\nDEVILUDO_S3_PATH_STYLE=%s\nDEVILUDO_ARTIFACT_BUCKET=%s\nDEVILUDO_STEAM_APP_ID=%s\nDEVILUDO_STEAM_DEPOT_LINUX=%s\nDEVILUDO_STEAM_DEPOT_WINDOWS=%s\nDEVILUDO_STEAM_DEPOT_MACOS=%s\n' "$executor_image" "$allowed" "$agent_smoke_image" "$(stat -c %g /var/run/docker.sock)" "$DEVILUDO_PROVIDER_ALLOWLIST" "$DEVILUDO_VAULT_ADDR" "$DEVILUDO_S3_ENDPOINT" "${DEVILUDO_S3_REGION:-us-east-1}" "${DEVILUDO_S3_PATH_STYLE:-0}" "$DEVILUDO_ARTIFACT_BUCKET" "$DEVILUDO_STEAM_APP_ID" "$DEVILUDO_STEAM_DEPOT_LINUX" "$DEVILUDO_STEAM_DEPOT_WINDOWS" "$DEVILUDO_STEAM_DEPOT_MACOS" > "$stage/executor.env"
  chmod 0600 "$stage/runtime.env" "$stage/executor.env"
  systemctl daemon-reload
  compose_role "$stage" --profile init run --rm migrate
  compose_role "$stage" --profile init run --rm register-executor
}
install_kata_runtime() {
  local manifest=$1 stage=$2 version url expected archive extract target
  version=$(jq -er '.externalArtifacts.kata.version' "$manifest")
  url=$(jq -er '.externalArtifacts.kata.url' "$manifest")
  expected=$(jq -er '.externalArtifacts.kata.sha256' "$manifest")
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $url == "https://github.com/kata-containers/kata-containers/releases/download/$version/kata-static-$version-amd64.tar.xz" && $expected =~ ^[0-9a-f]{64}$ ]] || { log "signed Kata metadata is invalid"; return 1; }
  target="/opt/deviludo-runtimes/kata/$version"
  if [[ ! -x $target/bin/containerd-shim-kata-v2 ]]; then
    archive=$(mktemp); extract=$(mktemp -d)
    curl --fail --silent --show-error --location "$url" -o "$archive"
    verify_sha256 "$expected" "$archive" || { rm -f "$archive"; rm -rf "$extract"; log "Kata checksum mismatch"; return 1; }
    tar -xJf "$archive" -C "$extract"
    [[ -x $extract/opt/kata/bin/containerd-shim-kata-v2 && -x $extract/opt/kata/bin/kata-runtime ]] || { rm -f "$archive"; rm -rf "$extract"; log "Kata bundle is incomplete"; return 1; }
    install -d -m 0755 /opt/deviludo-runtimes/kata
    mv "$extract/opt/kata" "$target"
    rm -f "$archive"; rm -rf "$extract"
  fi
  printf '%s\n' "$version" > "$stage/kata-runtime.version"
}
activate_kata_runtime() {
  local version target
  version=$(< /opt/deviludo/current/kata-runtime.version)
  target="/opt/deviludo-runtimes/kata/$version"
  [[ -x $target/bin/containerd-shim-kata-v2 && -x $target/bin/kata-runtime ]] || { log "verified Kata runtime is not installed"; return 1; }
  ln -sfn "$target" /opt/kata
  ln -sfn /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
  ln -sfn /opt/kata/bin/kata-runtime /usr/local/bin/kata-runtime
  /usr/local/bin/kata-runtime check
}
role_restart() { activate_kata_runtime; compose_role /opt/deviludo/current --profile init run --rm bootstrap-vault; compose_role /opt/deviludo/current --profile init run --rm bootstrap-object-store; compose_role /opt/deviludo/current --profile init run --rm register-runtimes; compose_role /opt/deviludo/current up -d --remove-orphans; systemctl enable --now deviludo-executord; systemctl restart deviludo-executord; }
role_healthcheck() { local body; body=$(mktemp); local status; status=$(curl --silent --show-error --output "$body" --write-out '%{http_code}' --cacert "$DEVILUDO_TLS_SERVER_CA_FILE" "https://${DEVILUDO_CORE_BIND_ADDRESS}:8443/health/ready"); [[ $status == 200 || $status == 503 ]] && jq -e '.status == "ready" or .status == "not_ready"' "$body" >/dev/null; rm -f "$body"; compose_role /opt/deviludo/current --profile smoke run --rm executor-smoke; }
role_stop() { systemctl stop deviludo-executord || true; compose_role /opt/deviludo/current down; }
role_status() { compose_role /opt/deviludo/current ps; systemctl --no-pager status deviludo-executord; }
dispatch "$@"
