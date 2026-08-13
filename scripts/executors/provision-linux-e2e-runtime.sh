#!/usr/bin/env bash
set -Eeuo pipefail
source_root=${1:?repository root is required}
guest_user=${DEVILUDO_E2E_GUEST_USER:-deviludo-guest}
[[ $source_root == /* && -f $source_root/scripts/executors/linux-uinput-gamepad-driver.c ]]
[[ $(id -u) == 0 ]]
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential pkg-config libjson-c-dev ffmpeg godot
install -d -m 0755 /usr/local/lib/deviludo/executors
bash "$source_root/scripts/executors/build-linux-gamepad-driver.sh" \
  "$source_root/scripts/executors/linux-uinput-gamepad-driver.c" /usr/local/bin/deviludo-gamepad-driver
install -m 0555 "$source_root/scripts/executors/godot-window-e2e-guest.mjs" /usr/local/lib/deviludo/executors/godot-window-e2e-guest.mjs
install -m 0444 "$source_root/scripts/executors/game-test-environment.mjs" /usr/local/lib/deviludo/executors/game-test-environment.mjs
install -m 0444 "$source_root/scripts/e2e-evidence.mjs" /usr/local/lib/deviludo/e2e-evidence.mjs
install -m 0444 "$source_root/scripts/e2e-ui-probe.mjs" /usr/local/lib/deviludo/e2e-ui-probe.mjs
groupadd --system deviludo-input 2>/dev/null || true
usermod -aG deviludo-input "$guest_user"
printf 'uinput\n' > /etc/modules-load.d/deviludo-uinput.conf
printf 'KERNEL=="uinput", GROUP="deviludo-input", MODE="0660"\n' > /etc/udev/rules.d/70-deviludo-uinput.rules
modprobe uinput
udevadm control --reload-rules
udevadm trigger --name-match=uinput
test -c /dev/uinput
DEVILUDO_GAMEPAD_DRIVER=/usr/local/bin/deviludo-gamepad-driver \
DEVILUDO_GODOT=${DEVILUDO_GODOT:-/usr/bin/godot} \
  /usr/local/bin/node "$source_root/scripts/executors/godot-system-gamepad-smoke.mjs" \
    "$source_root/fixtures/godot-input-smoke"
