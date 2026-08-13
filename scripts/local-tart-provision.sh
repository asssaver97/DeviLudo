#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
guest_root=/usr/local/lib/deviludo
sudo install -d -m 0755 "$guest_root" "$guest_root/executors"
sudo install -m 0555 /Users/Shared/godot-window-e2e-guest.mjs "$guest_root/executors/godot-window-e2e-guest.mjs"
sudo install -m 0444 /Users/Shared/game-test-environment.mjs "$guest_root/executors/game-test-environment.mjs"
sudo install -m 0444 /Users/Shared/gui-event-batches.mjs "$guest_root/executors/gui-event-batches.mjs"
sudo install -m 0444 /Users/Shared/e2e-evidence.mjs "$guest_root/e2e-evidence.mjs"
sudo install -m 0444 /Users/Shared/e2e-ui-probe.mjs "$guest_root/e2e-ui-probe.mjs"
sudo install -m 0555 /Users/Shared/deviludo-gui-driver /usr/local/bin/deviludo-gui-driver
sudo install -m 0555 /Users/Shared/deviludo-gamepad-driver /usr/local/bin/deviludo-gamepad-driver
if [[ ! -x /opt/homebrew/bin/ffmpeg ]]; then
  # Provisioning is launched through sudo so privileged image changes remain
  # non-interactive. Homebrew must still run as the unprivileged guest owner.
  sudo -u admin -H /opt/homebrew/bin/brew install ffmpeg
fi
sudo ln -sfn /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg
sudo ln -sfn /opt/homebrew/bin/ffprobe /usr/local/bin/ffprobe
if [[ ! -x /usr/local/bin/node ]]; then
  curl -fsSL "https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz" -o /Users/Shared/node.tar.gz
  tar -xzf /Users/Shared/node.tar.gz -C /Users/Shared
  sudo install -m 0555 /Users/Shared/node-v22.22.0-darwin-arm64/bin/node /usr/local/bin/node
fi
if [[ ! -x /Applications/Godot.app/Contents/MacOS/Godot ]]; then
  curl -fsSL "https://github.com/godotengine/godot/releases/download/4.5.1-stable/Godot_v4.5.1-stable_macos.universal.zip" -o /Users/Shared/godot.zip
  ditto -x -k /Users/Shared/godot.zip /Users/Shared/godot
  sudo ditto /Users/Shared/godot/Godot.app /Applications/Godot.app
fi
sudo ln -sfn /Applications/Godot.app/Contents/MacOS/Godot /usr/local/bin/godot
# The Cirrus base image logs admin into the desktop automatically. Changing the
# password without updating loginwindow leaves subsequent golden-image clones
# at the login screen: WindowServer exists, but GUI apps launched over SSH can
# never create an on-screen window. Keep the replacement credential and update
# macOS' native auto-login record atomically for this disposable E2E guest.
# Use explicit administrator credentials: running sysadminctl as root without
# them updates autoLoginUser but leaves the old /etc/kcpassword behind.
sudo /usr/sbin/sysadminctl \
  -resetPasswordFor admin \
  -newPassword "$DEVILUDO_REPLACEMENT_PASSWORD" \
  -adminUser admin \
  -adminPassword admin
sudo dscl . -authonly admin "$DEVILUDO_REPLACEMENT_PASSWORD"
# On Tahoe, sysadminctl -autologin reports success while emitting
# SACSetAutoLoginPassword error:22 and leaves the old record untouched when it
# runs through an SSH provisioning session. Generate the loginwindow record
# explicitly, then prove it was installed before the VM is snapshotted.
/usr/local/bin/node -e '
  const { randomFillSync } = require("node:crypto");
  const { writeFileSync } = require("node:fs");
  const secret = Buffer.from(process.env.DEVILUDO_REPLACEMENT_PASSWORD, "utf8");
  const key = Buffer.from([0x7d, 0x89, 0x52, 0x23, 0xd2, 0xbc, 0xdd, 0xea, 0xa3, 0xb9, 0x1f]);
  const plain = Buffer.alloc(Math.ceil((secret.length + 1) / 12) * 12);
  secret.copy(plain);
  plain[secret.length] = 0;
  if (secret.length + 1 < plain.length) randomFillSync(plain, secret.length + 1);
  for (let index = 0; index < plain.length; index += 1) plain[index] ^= key[index % key.length];
  writeFileSync("/Users/Shared/deviludo-kcpassword", plain, { mode: 0o600 });
'
sudo install -o root -g wheel -m 0600 /Users/Shared/deviludo-kcpassword /etc/kcpassword
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser admin
kcpassword_size="$(stat -f '%z' /etc/kcpassword)"
[[ "$kcpassword_size" -gt 12 ]]
sudo sync
sleep 3
