#!/usr/bin/env bash
set -Eeuo pipefail
DEVILUDO_ROLE=WEB
# shellcheck source=../common/lib.sh
source "$(cd "$(dirname "$0")/../common" && pwd)/lib.sh"
role_preflight() { require_command curl; require_command jq; require_file "${DEVILUDO_WEB_CORE_TOKEN_FILE:?}"; }
role_bootstrap() {
  ubuntu_docker_bootstrap
  useradd --system --uid 1001 --home /var/lib/deviludo-web --shell /usr/sbin/nologin deviludo-web 2>/dev/null || true
  install -d -m 0711 -o root -g root /etc/deviludo/web
  install -d -m 0750 -o deviludo-web -g deviludo-web /var/lib/deviludo-web
  configure_ufw "$DEVILUDO_WEB_BIND_ADDRESS" 3100 "${DEVILUDO_WEB_ALLOWED_CIDRS:?}"
}
role_validate_config() {
  require_file "$DEVILUDO_WEB_CORE_TOKEN_FILE"
  [[ ${DEVILUDO_CORE_URL:-} == https://* \
    && ${DEVILUDO_WEB_BIND_ADDRESS:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ \
    && ${DEVILUDO_WEB_BIND_ADDRESS:-} != 0.0.0.0 \
    && ${DEVILUDO_WEB_BIND_ADDRESS:-} != 127.0.0.1 \
    && ${DEVILUDO_WEB_ALLOWED_CIDRS:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}(,([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2})*$ ]] || return 1
}
role_verify_images() { verify_and_pull_image "$(image_from_manifest "$1" '-web@')"; }
role_install() { install -m 0400 -o 1001 -g 1001 "$DEVILUDO_WEB_CORE_TOKEN_FILE" /etc/deviludo/web/core.token; mv "$1/web.compose.yaml" "$1/compose.yaml"; printf 'DEVILUDO_WEB_IMAGE=%s\nDEVILUDO_CORE_URL=%s\nDEVILUDO_WEB_BIND_ADDRESS=%s\n' "$(image_from_manifest "$1/release-manifest.json" '-web@')" "$DEVILUDO_CORE_URL" "$DEVILUDO_WEB_BIND_ADDRESS" > "$1/runtime.env"; chmod 0600 "$1/runtime.env"; }
role_restart() { compose_role /opt/deviludo/current up -d --remove-orphans; }
role_stop() { compose_role /opt/deviludo/current down; }
role_healthcheck() { curl --fail --silent --show-error "http://${DEVILUDO_WEB_BIND_ADDRESS}:3100/api/health/live" >/dev/null; }
role_status() { compose_role /opt/deviludo/current ps; }
dispatch "$@"
