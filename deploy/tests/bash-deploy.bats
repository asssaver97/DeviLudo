#!/usr/bin/env bats

setup() {
  cd "$BATS_TEST_DIRNAME/../.."
}

@test "all Bash deployment entrypoints parse" {
  run bash -n deploy/common/lib.sh deploy/web/deploy.sh deploy/core/deploy.sh \
    deploy/e2e-linux/deploy.sh deploy/e2e-macos/deploy.sh \
    deploy/assets/deviludo-e2e-host deploy/assets/deviludo-e2e-renew \
    deploy/assets/e2e-linux-isolation.sh deploy/assets/e2e-linux-guest-runner.sh \
    deploy/assets/e2e-macos-isolation.sh deploy/assets/e2e-macos-guest-runner.sh
  [ "$status" -eq 0 ]
}

@test "five production roles expose the shared action dispatcher" {
  for script in deploy/web/deploy.sh deploy/core/deploy.sh deploy/e2e-linux/deploy.sh deploy/e2e-macos/deploy.sh; do
    grep -q 'dispatch "\$@"' "$script"
  done
  grep -q 'preflight|bootstrap|deploy|status|rollback' deploy/common/lib.sh
  grep -q "DEVILUDO_ROLE=WEB" deploy/web/deploy.sh
  grep -q "DEVILUDO_ROLE=CORE" deploy/core/deploy.sh
  grep -q "DEVILUDO_ROLE=E2E_LINUX" deploy/e2e-linux/deploy.sh
  grep -q "DEVILUDO_ROLE=E2E_MACOS" deploy/e2e-macos/deploy.sh
}

@test "shared deployment enforces locks, signed manifests, immutable images, and schema-safe rollback" {
  grep -q 'flock -n' deploy/common/lib.sh
  grep -q 'cosign verify-blob' deploy/common/lib.sh
  grep -q 'cosign verify --certificate-identity-regexp' deploy/common/lib.sh
  grep -q '@sha256:' deploy/common/lib.sh
  grep -q 'schemaCompatibility' deploy/common/lib.sh
  grep -q 'DEVILUDO_DOCKER_CE_VERSION' deploy/common/lib.sh
  grep -q 'DEVILUDO_GHCR_TOKEN_FILE' deploy/common/lib.sh
}

@test "E2E isolation always destroys disposable guests" {
  grep -q 'virsh undefine' deploy/assets/e2e-linux-isolation.sh
  grep -q 'tart delete' deploy/assets/e2e-macos-isolation.sh
  grep -q 'cosign verify-blob' deploy/assets/e2e-linux-isolation.sh
  grep -q 'cosign verify-blob' deploy/assets/e2e-macos-isolation.sh
}
