#!/usr/bin/env bash
set -Eeuo pipefail
action=${1:?}; shift
job_id= artifact=
while (($#)); do case "$1" in --job-id) job_id=$2; shift 2;; --artifact) artifact=$2; shift 2;; *) exit 64;; esac; done
[[ $action == test || $action == clean-install ]]
[[ $job_id =~ ^[0-9a-f-]{36}$ && -r $artifact ]]
vm="deviludo-$job_id"
for _ in {1..120}; do
  ip=$(virsh domifaddr "$vm" --source agent 2>/dev/null | awk '/ipv4/ {sub("/.*", "", $4); print $4; exit}')
  [[ -n ${ip:-} ]] && break
  sleep 1
done
[[ -n ${ip:-} ]] || { echo 'guest agent did not report an address' >&2; exit 1; }
ssh_options=(-i /etc/deviludo/e2e/guest_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/deviludo/e2e/guest_known_hosts)
scp "${ssh_options[@]}" "$artifact" "deviludo-guest@$ip:/var/lib/deviludo/input/artifact"
ssh "${ssh_options[@]}" "deviludo-guest@$ip" /usr/local/bin/deviludo-guest-runner "$action" /var/lib/deviludo/input/artifact --json
