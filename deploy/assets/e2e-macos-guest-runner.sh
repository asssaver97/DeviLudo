#!/usr/bin/env bash
set -Eeuo pipefail
action=${1:?}; shift
job_id= artifact=
while (($#)); do case "$1" in --job-id) job_id=$2; shift 2;; --artifact) artifact=$2; shift 2;; *) exit 64;; esac; done
[[ $action == test || $action == clean-install ]]
[[ $job_id =~ ^[0-9a-f-]{36}$ && -r $artifact ]]
vm="deviludo-$job_id"
for _ in {1..120}; do ip=$(tart ip "$vm" 2>/dev/null || true); [[ -n $ip ]] && break; sleep 1; done
[[ -n ${ip:-} ]] || { echo 'Tart guest did not report an address' >&2; exit 1; }
ssh_options=(-i "/Library/Application Support/DeviludoE2E/guest_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="/Library/Application Support/DeviludoE2E/guest_known_hosts")
scp "${ssh_options[@]}" "$artifact" "deviludo-guest@$ip:/Users/Shared/deviludo-artifact"
receipt=$(ssh "${ssh_options[@]}" "deviludo-guest@$ip" /usr/local/bin/deviludo-guest-runner "$action" /Users/Shared/deviludo-artifact --job-id "$job_id" --json)
if [[ $action == test || $action == clean-install ]]; then
  : "${DEVILUDO_E2E_HOST_OUTPUT:?host evidence output is required}"
  guest_output=$(jq -er '.outputPath' <<<"$receipt")
  [[ $guest_output == /Users/Shared/* ]] || { echo 'guest evidence path escaped the shared directory' >&2; exit 1; }
  scp "${ssh_options[@]}" "deviludo-guest@$ip:$guest_output" "$DEVILUDO_E2E_HOST_OUTPUT"
  receipt=$(jq -c --arg path "$DEVILUDO_E2E_HOST_OUTPUT" '.outputPath=$path' <<<"$receipt")
fi
printf '%s' "$receipt"
