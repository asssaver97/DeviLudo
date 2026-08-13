#!/usr/bin/env bash
set -Eeuo pipefail
action=${1:?}; shift
job_id='' artifact='' regression=''
while (($#)); do case "$1" in
  --job-id) job_id=$2; shift 2;;
  --artifact) artifact=$2; shift 2;;
  --regression) regression=$2; shift 2;;
  *) exit 64;;
esac; done
[[ $action == test && $job_id =~ ^[0-9a-f-]{36}$ && -r $artifact ]]
[[ -z $regression || -r $regression ]]
vm="deviludo-$job_id"
for _ in {1..120}; do ip=$(tart ip "$vm" 2>/dev/null || true); [[ -n $ip ]] && break; sleep 1; done
[[ -n ${ip:-} ]] || { echo 'Tart guest did not report an address' >&2; exit 1; }
ssh_options=(-i "/Library/Application Support/DeviludoE2E/guest_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="/Library/Application Support/DeviludoE2E/guest_known_hosts")
remote_artifact="/Users/Shared/deviludo-artifact-$job_id"
remote_regression="/Users/Shared/deviludo-regression-$job_id.json"
scp "${ssh_options[@]}" "$artifact" "deviludo-guest@$ip:$remote_artifact"
regression_arguments=()
if [[ -n $regression ]]; then
  scp "${ssh_options[@]}" "$regression" "deviludo-guest@$ip:$remote_regression"
  regression_arguments=(--regression "$remote_regression")
fi
relay_root=$(mktemp -d /tmp/deviludo-e2e-relay.XXXXXX)
mkfifo "$relay_root/to-guest" "$relay_root/from-guest"
trap 'rm -rf "$relay_root"' EXIT
ssh "${ssh_options[@]}" "deviludo-guest@$ip" env \
    DEVILUDO_GUI_DRIVER=/usr/local/bin/deviludo-gui-driver \
    DEVILUDO_GAMEPAD_DRIVER=/usr/local/bin/deviludo-gamepad-driver \
    DEVILUDO_GUEST_EVIDENCE_ROOT=/Users/Shared DEVILUDO_GUEST_JOB_ROOT=/Users/Shared \
    DEVILUDO_E2E_STREAM_PROTOCOL=1 "DEVILUDO_E2E_PROJECT_ID=${DEVILUDO_E2E_PROJECT_ID:-$job_id}" \
    "DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS=${DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS:-}" \
    "DEVILUDO_E2E_CONTRACT_DIGEST=${DEVILUDO_E2E_CONTRACT_DIGEST:-}" \
    /usr/local/bin/deviludo-guest-runner test "$remote_artifact" --job-id "$job_id" --json "${regression_arguments[@]}" \
    <"$relay_root/to-guest" >"$relay_root/from-guest" &
guest_pid=$!
exec 3>"$relay_root/to-guest"
exec 4<"$relay_root/from-guest"
receipt=
while IFS= read -r line <&4; do
  message_type=$(jq -er '.type' <<<"$line")
  if [[ $message_type == policy_request ]]; then
    printf '%s\n' "$line"
    IFS= read -r response || { echo 'player policy relay closed' >&2; exit 1; }
    [[ $(jq -r '.type' <<<"$response") == policy_response ]] || { echo 'invalid player policy response' >&2; exit 1; }
    printf '%s\n' "$response" >&3
  elif [[ $message_type == result ]]; then
    receipt=$(jq -ce '.value' <<<"$line")
  else
    echo 'guest emitted an unknown frame' >&2; exit 1
  fi
done
wait "$guest_pid"
[[ -n $receipt ]] || { echo 'guest omitted its result' >&2; exit 1; }
: "${DEVILUDO_E2E_HOST_OUTPUT:?host evidence output is required}"
guest_output=$(jq -er '.outputPath' <<<"$receipt")
[[ $guest_output == /Users/Shared/* ]] || { echo 'guest evidence path escaped the shared directory' >&2; exit 1; }
scp "${ssh_options[@]}" "deviludo-guest@$ip:$guest_output" "$DEVILUDO_E2E_HOST_OUTPUT"
receipt=$(jq -c --arg path "$DEVILUDO_E2E_HOST_OUTPUT" '.outputPath=$path' <<<"$receipt")
guest_regression=$(jq -r '.regressionOutputPath // empty' <<<"$receipt")
if [[ -n $guest_regression ]]; then
  : "${DEVILUDO_E2E_HOST_REGRESSION_OUTPUT:?host regression output is required}"
  [[ $guest_regression == /Users/Shared/* ]] || { echo 'guest regression path escaped the shared directory' >&2; exit 1; }
  scp "${ssh_options[@]}" "deviludo-guest@$ip:$guest_regression" "$DEVILUDO_E2E_HOST_REGRESSION_OUTPUT"
  receipt=$(jq -c --arg path "$DEVILUDO_E2E_HOST_REGRESSION_OUTPUT" '.regressionOutputPath=$path' <<<"$receipt")
fi
jq -cn --argjson value "$receipt" '{type:"result",value:$value}'
