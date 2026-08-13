#!/usr/bin/env bash
set -Eeuo pipefail

DEVILUDO_ROLE=${DEVILUDO_ROLE:?DEVILUDO_ROLE is required}
DEVILUDO_CONFIG=${DEVILUDO_CONFIG:-/etc/deviludo/deploy.env}
DEVILUDO_ROOT=${DEVILUDO_ROOT:-/opt/deviludo}
DEVILUDO_STATE=${DEVILUDO_STATE:-/var/lib/deviludo-deploy}
DEVILUDO_LOG=${DEVILUDO_LOG:-/var/log/deviludo-deploy.log}

log() {
  local message=${1//${DEVILUDO_GHCR_TOKEN:-__unset__}/[REDACTED]}
  message=${message//${DEVILUDO_VAULT_TOKEN:-__unset__}/[REDACTED]}
  printf '%s role=%s %s\n' "$(date -u +%FT%TZ)" "$DEVILUDO_ROLE" "$message" | tee -a "$DEVILUDO_LOG"
}

load_config() {
  [[ -f "$DEVILUDO_CONFIG" ]] || { log "missing config: $DEVILUDO_CONFIG"; return 1; }
  # shellcheck disable=SC1090
  set -a
  source "$DEVILUDO_CONFIG"
  set +a
  : "${DEVILUDO_RELEASE_VERSION:?release version is required}"
  : "${DEVILUDO_RELEASE_BASE_URL:?release base URL is required}"
  : "${DEVILUDO_COSIGN_IDENTITY_REGEXP:?Cosign identity regexp is required}"
  : "${DEVILUDO_COSIGN_ISSUER:?Cosign issuer is required}"
  [[ $DEVILUDO_ROOT == /opt/deviludo ]] || { log "DEVILUDO_ROOT must be /opt/deviludo for signed service assets"; return 1; }
}

image_from_manifest() {
  local manifest=$1 suffix=$2
  jq -er --arg suffix "$suffix" '.images[] | select(contains($suffix))' "$manifest" | head -n 1
}

compose_role() {
  local role_dir=$1; shift
  docker compose --env-file "$role_dir/runtime.env" -f "$role_dir/compose.yaml" "$@"
}

require_root() { [[ ${EUID:-$(id -u)} -eq 0 ]] || { log "root privileges are required"; return 1; }; }
require_file() { [[ -r "$1" ]] || { log "required file is missing: $1"; return 1; }; }
require_command() { command -v "$1" >/dev/null || { log "required command is missing: $1"; return 1; }; }

verify_sha256() {
  local expected=$1 file=$2 actual
  if command -v sha256sum >/dev/null; then actual=$(sha256sum "$file" | cut -d' ' -f1)
  else actual=$(shasum -a 256 "$file" | cut -d' ' -f1); fi
  [[ $actual == "$expected" ]]
}

with_lock() {
  mkdir -p "$DEVILUDO_STATE" "$(dirname "$DEVILUDO_LOG")"
  if command -v flock >/dev/null; then
    exec 9>"$DEVILUDO_STATE/deploy.lock"
    flock -n 9 || { log "another deployment is running"; return 75; }
    "$@"
  else
    local lock_directory="$DEVILUDO_STATE/deploy.lock.d"
    mkdir "$lock_directory" 2>/dev/null || { log "another deployment is running"; return 75; }
    trap 'rmdir "$lock_directory"' RETURN
    "$@"
    trap - RETURN
    rmdir "$lock_directory"
  fi
}

download_release() {
  local target=$1
  local base="${DEVILUDO_RELEASE_BASE_URL%/}/${DEVILUDO_RELEASE_VERSION}"
  mkdir -p "$target"
  release_curl "$base/release-manifest.json" "$target/release-manifest.json"
  release_curl "$base/release-manifest.json.sig" "$target/release-manifest.json.sig"
  release_curl "$base/release-manifest.json.pem" "$target/release-manifest.json.pem"
  cosign verify-blob --certificate "$target/release-manifest.json.pem" --signature "$target/release-manifest.json.sig" \
    --certificate-identity-regexp "$DEVILUDO_COSIGN_IDENTITY_REGEXP" --certificate-oidc-issuer "$DEVILUDO_COSIGN_ISSUER" \
    "$target/release-manifest.json" >/dev/null
  jq -e --arg role "$DEVILUDO_ROLE" --arg version "$DEVILUDO_RELEASE_VERSION" \
    '.schemaVersion == "deviludo.release.v1" and .version == $version and (.roles | index($role)) != null
      and .plugins.GODOT.version == "2"
      and .plugins.GODOT.testManifestProtocol == "deviludo.test-manifest.v2"
      and .plugins.GODOT.guestReportProtocol == "deviludo.godot-guest-report.v2"
      and .plugins.GODOT.evidenceProtocol == "deviludo.e2e-evidence.v1"
      and .plugins.GODOT.artifactHostCommandsAllowed == false
      and (.plugins.GODOT.builderImage | test("@sha256:[0-9a-f]{64}$"))' \
    "$target/release-manifest.json" >/dev/null
  local bundle checksum
  bundle=$(jq -r --arg role "$DEVILUDO_ROLE" '.bundles[$role].file' "$target/release-manifest.json")
  checksum=$(jq -r --arg role "$DEVILUDO_ROLE" '.bundles[$role].sha256' "$target/release-manifest.json")
  [[ $bundle != null && $checksum =~ ^[0-9a-f]{64}$ ]] || { log "release bundle metadata is invalid"; return 1; }
  release_curl "$base/$bundle" "$target/$bundle"
  verify_sha256 "$checksum" "$target/$bundle"
  tar -xzf "$target/$bundle" -C "$target"
}

release_curl() {
  local url=$1 output=$2
  local arguments=(--fail --silent --show-error --location)
  if [[ -n ${DEVILUDO_RELEASE_AUTH_HEADER_FILE:-} ]]; then
    require_file "$DEVILUDO_RELEASE_AUTH_HEADER_FILE"
    [[ $(<"$DEVILUDO_RELEASE_AUTH_HEADER_FILE") == "Authorization: Bearer "* ]] \
      || { log "release auth file must contain an Authorization: Bearer header"; return 1; }
    arguments+=(--header "@$DEVILUDO_RELEASE_AUTH_HEADER_FILE")
  fi
  curl "${arguments[@]}" "$url" -o "$output"
}

verify_images() {
  declare -F role_verify_images >/dev/null && role_verify_images "$1"
}

verify_and_pull_image() {
  local image=$1
  [[ $image =~ @sha256:[0-9a-f]{64}$ ]] || { log "mutable image reference rejected"; return 1; }
  cosign verify --certificate-identity-regexp "$DEVILUDO_COSIGN_IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$DEVILUDO_COSIGN_ISSUER" "$image" >/dev/null
  docker pull "$image" >/dev/null
}

activate_release() {
  local release=$1
  mkdir -p "$DEVILUDO_ROOT/releases"
  local target="$DEVILUDO_ROOT/releases/$DEVILUDO_RELEASE_VERSION"
  if [[ -e "$target" ]]; then
    cmp -s "$release/release-manifest.json" "$target/release-manifest.json" \
      || { log "release version already exists with different manifest"; return 1; }
    rm -rf -- "$release"
  else
    mv "$release" "$target"
  fi
  if [[ $(uname -s) == Darwin ]]; then ln -sfn "$target" "$DEVILUDO_ROOT/current"
  else ln -sfn "$target" "$DEVILUDO_ROOT/.current-next"; mv -Tf "$DEVILUDO_ROOT/.current-next" "$DEVILUDO_ROOT/current"; fi
  printf '%s\n' "$DEVILUDO_RELEASE_VERSION" > "$DEVILUDO_STATE/active-version"
}

rollback_release() {
  require_root
  load_config
  local target_version=${DEVILUDO_ROLLBACK_VERSION:?set DEVILUDO_ROLLBACK_VERSION in the config file}
  local target="$DEVILUDO_ROOT/releases/$target_version"
  require_file "$target/release-manifest.json"
  local active_schema target_schema
  active_schema=$(jq -r '.database.schemaCompatibility' "$DEVILUDO_ROOT/current/release-manifest.json")
  target_schema=$(jq -r '.database.schemaCompatibility' "$target/release-manifest.json")
  [[ $active_schema == "$target_schema" ]] || { log "rollback refused: database schema compatibility differs"; return 1; }
  if [[ $(uname -s) == Darwin ]]; then ln -sfn "$target" "$DEVILUDO_ROOT/current"
  else ln -sfn "$target" "$DEVILUDO_ROOT/.current-next"; mv -Tf "$DEVILUDO_ROOT/.current-next" "$DEVILUDO_ROOT/current"; fi
  role_restart
  log "rolled back to $target_version"
}

ubuntu_docker_bootstrap() {
  require_root
  . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || { log "Ubuntu 24.04 is required"; return 1; }
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "${UBUNTU_CODENAME:-noble}" > /etc/apt/sources.list.d/docker.list
  apt-get update
  : "${DEVILUDO_DOCKER_CE_VERSION:?fixed Docker CE apt version is required}"
  : "${DEVILUDO_CONTAINERD_VERSION:?fixed containerd apt version is required}"
  : "${DEVILUDO_BUILDX_VERSION:?fixed Buildx apt version is required}"
  : "${DEVILUDO_COMPOSE_VERSION:?fixed Compose apt version is required}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades \
    "docker-ce=$DEVILUDO_DOCKER_CE_VERSION" "docker-ce-cli=$DEVILUDO_DOCKER_CE_VERSION" \
    "containerd.io=$DEVILUDO_CONTAINERD_VERSION" "docker-buildx-plugin=$DEVILUDO_BUILDX_VERSION" \
    "docker-compose-plugin=$DEVILUDO_COMPOSE_VERSION" \
    curl jq ca-certificates ufw
  install_cosign_linux
  systemctl enable --now docker
}

install_cosign_linux() {
  local version=3.1.2 architecture expected temporary
  architecture=$(dpkg --print-architecture)
  case "$architecture" in
    amd64) expected=f7622ed3cf22e55e1ae6377c080979ff77a22da9981c11df222a2e444991e7cf ;;
    arm64) expected=90e7ae0b5dfd60f20816b52c012addf7fc055ebcc7bea4ce81c428ca8518c302 ;;
    *) log "unsupported Cosign architecture: $architecture"; return 1 ;;
  esac
  if command -v cosign >/dev/null && [[ $(cosign version 2>/dev/null) == *"v$version"* ]]; then return; fi
  temporary=$(mktemp)
  curl --fail --silent --show-error --location "https://github.com/sigstore/cosign/releases/download/v${version}/cosign-linux-${architecture}" -o "$temporary"
  verify_sha256 "$expected" "$temporary"
  install -m 0755 "$temporary" /usr/local/bin/cosign
  rm -f "$temporary"
}

install_node_linux() {
  local version=22.22.0 architecture expected temporary
  architecture=$(uname -m)
  case "$architecture" in
    x86_64) architecture=x64; expected=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37 ;;
    aarch64|arm64) architecture=arm64; expected=1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f ;;
    *) log "unsupported Node architecture: $architecture"; return 1 ;;
  esac
  if command -v node >/dev/null && [[ $(node --version) == "v$version" ]]; then return; fi
  temporary=$(mktemp)
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${version}/node-v${version}-linux-${architecture}.tar.xz" -o "$temporary"
  verify_sha256 "$expected" "$temporary"
  tar -xJf "$temporary" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "$temporary"
  [[ $(/usr/local/bin/node --version) == "v$version" ]]
}

configure_ufw() {
  local bind_address=${1:-} port=${2:-} allowed_cidrs=${3:-} cidr
  [[ ${DEVILUDO_SSH_ALLOWED_CIDRS:-} =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}(,([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2})*$ ]] \
    || { log "DEVILUDO_SSH_ALLOWED_CIDRS is invalid"; return 1; }
  IFS=, read -ra ssh_cidrs <<<"${DEVILUDO_SSH_ALLOWED_CIDRS:?}"
  ufw default deny incoming
  ufw default allow outgoing
  for cidr in "${ssh_cidrs[@]}"; do ufw allow from "$cidr" to any port 22 proto tcp; done
  if [[ -n $bind_address && -n $port ]]; then
    IFS=, read -ra service_cidrs <<<"$allowed_cidrs"
    for cidr in "${service_cidrs[@]}"; do ufw allow from "$cidr" to "$bind_address" port "$port" proto tcp; done
    ufw deny in to "$bind_address" port "$port" proto tcp
  fi
  ufw --force enable
}

deploy_release() {
  require_root
  load_config
  require_command curl; require_command jq; require_command cosign
  local stage previous="" docker_config=""
  install -d -m 0755 "$DEVILUDO_ROOT"
  stage=$(mktemp -d "$DEVILUDO_ROOT/.stage.XXXXXX")
  trap 'rm -rf -- "$stage" "$docker_config"' RETURN
  if [[ -n ${DEVILUDO_GHCR_TOKEN_FILE:-} ]]; then
    require_command docker
    require_file "$DEVILUDO_GHCR_TOKEN_FILE"
    : "${DEVILUDO_GHCR_USERNAME:?GHCR username is required with a token file}"
    docker_config=$(mktemp -d "$DEVILUDO_STATE/docker-config.XXXXXX")
    chmod 0700 "$docker_config"
    export DOCKER_CONFIG=$docker_config
    docker login ghcr.io --username "$DEVILUDO_GHCR_USERNAME" --password-stdin \
      < "$DEVILUDO_GHCR_TOKEN_FILE" >/dev/null
  fi
  download_release "$stage"
  verify_images "$stage/release-manifest.json"
  role_validate_config
  role_install "$stage"
  [[ -L $DEVILUDO_ROOT/current ]] && previous=$(readlink "$DEVILUDO_ROOT/current")
  activate_release "$stage"
  if ! role_restart || ! role_healthcheck; then
    log "deployment health check failed"
    if [[ -n $previous && -d $previous ]]; then
      if [[ $(uname -s) == Darwin ]]; then ln -sfn "$previous" "$DEVILUDO_ROOT/current"
      else ln -sfn "$previous" "$DEVILUDO_ROOT/.current-next"; mv -Tf "$DEVILUDO_ROOT/.current-next" "$DEVILUDO_ROOT/current"; fi
      role_restart || log "previous release restart also failed"
      log "restored previous release after failed deployment"
    elif declare -F role_stop >/dev/null; then
      role_stop || true
    fi
    return 1
  fi
  log "deployed $DEVILUDO_RELEASE_VERSION"
}

dispatch() {
  local action=${1:-}
  case "$action" in
    preflight) load_config; role_preflight ;;
    bootstrap) load_config; with_lock role_bootstrap ;;
    deploy) with_lock deploy_release ;;
    status) role_status ;;
    rollback) with_lock rollback_release ;;
    *) printf 'usage: %s preflight|bootstrap|deploy|status|rollback\n' "$0" >&2; return 64 ;;
  esac
}
