#!/usr/bin/env bash
set -Eeuo pipefail
action=${1:?}; shift
stage= job_id= workspace_id= generation= runtime_image=
while (($#)); do case "$1" in --stage) stage=$2; shift 2;; --job-id) job_id=$2; shift 2;; --workspace-id) workspace_id=$2; shift 2;; --generation) generation=$2; shift 2;; --runtime-image) runtime_image=$2; shift 2;; *) exit 64;; esac; done
[[ $job_id =~ ^[0-9a-f-]{36}$ && $workspace_id =~ ^[0-9a-f-]{36}$ && $generation =~ ^[0-9]+$ && $runtime_image =~ ^sha256:[0-9a-f]{64}$ ]] || exit 64
vm="deviludo-${job_id}"
job_root=${DEVILUDO_E2E_JOB_ROOT:?}
[[ $job_root == /* && $job_root != / ]] || { echo 'fixed E2E job root is invalid' >&2; exit 64; }
case "$action:$stage" in
  reimage:before)
    [[ "sha256:$(shasum -a 256 "$DEVILUDO_GOLDEN_VM_FILE" | cut -d' ' -f1)" == "$runtime_image" ]] || { echo 'golden VM digest does not match the leased runtime' >&2; exit 1; }
    cosign verify-blob --certificate "$DEVILUDO_GOLDEN_VM_FILE.pem" --signature "$DEVILUDO_GOLDEN_VM_FILE.sig" \
      --certificate-identity-regexp "$DEVILUDO_COSIGN_IDENTITY_REGEXP" --certificate-oidc-issuer "$DEVILUDO_COSIGN_ISSUER" "$DEVILUDO_GOLDEN_VM_FILE" >/dev/null
    tart clone "$DEVILUDO_GOLDEN_VM_NAME" "$vm"
    tart run "$vm" --no-graphics --serial >/var/lib/deviludo-e2e/"$job_id".serial.log 2>&1 &
    ;;
  cleanup:after|reimage:after)
    tart stop "$vm" >/dev/null 2>&1 || true
    tart delete "$vm" >/dev/null 2>&1 || true
    rm -f -- /var/lib/deviludo-e2e/"$job_id".serial.log
    find "$job_root" -maxdepth 1 -type d -name "deviludo-${job_id}-*" -exec rm -rf -- {} +
    ;;
  *) exit 64;;
esac
printf '%s:%s:%s:g%s:%s\n' "$action" "$stage" "$job_id" "$generation" "$DEVILUDO_GOLDEN_VM_NAME"
