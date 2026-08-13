#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

const project = process.argv[2];
const gamepadDriver = process.env.DEVILUDO_GAMEPAD_DRIVER ?? "";
const defaultGodot = process.platform === "darwin" ? "/Applications/Godot.app/Contents/MacOS/Godot"
  : process.platform === "win32" ? "C:\\Program Files\\Godot\\Godot.exe" : "/usr/bin/godot";
const godot = process.env.DEVILUDO_GODOT ?? defaultGodot;
const marker = process.env.DEVILUDO_GAMEPAD_SMOKE_MARKER ?? join(tmpdir(), "deviludo-system-gamepad-smoke.ok");
if (!isAbsolute(project ?? "") || !isAbsolute(gamepadDriver) || !isAbsolute(godot) || !isAbsolute(marker)) {
  throw new Error("Gamepad smoke configuration is invalid");
}
await rm(marker, { force: true });

const driver = spawn(gamepadDriver, ["serve", "--session", "golden-image-smoke"], { stdio: ["pipe", "pipe", "inherit"], shell: false });
const lines = createInterface({ input: driver.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
let sequence = 0;
async function request(command, payload = {}) {
  const id = `smoke-${++sequence}`;
  driver.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  const response = await Promise.race([
    lines.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Gamepad ${command} timed out`)), 15_000)),
  ]);
  if (response.done) throw new Error("Gamepad driver closed during smoke");
  const value = JSON.parse(response.value);
  if (value.id !== id || value.ok !== true) throw new Error(value.error ?? `Gamepad ${command} failed`);
}

let game = null;
try {
  await request("ready");
  game = spawn(godot, ["--path", project], {
    stdio: ["ignore", "inherit", "inherit"], shell: false,
    env: { ...process.env, DEVILUDO_GAMEPAD_SMOKE_MARKER: marker },
  });
  await new Promise((resolve, reject) => { game.once("spawn", resolve); game.once("error", reject); });
  await new Promise(resolve => setTimeout(resolve, 3_000));
  await request("sequence", { events: [{ type: "gamepad_button_tap", button: "A", delay_ms: 0 }] });
  const code = await new Promise(resolve => game.once("close", resolve));
  await access(marker);
  if (code !== 0) throw new Error(`Godot system gamepad smoke exited ${code}`);
  process.stdout.write("gamepad-smoke-ok\n");
} finally {
  if (game?.exitCode === null) game.kill("SIGKILL");
  await request("release_all").catch(() => undefined);
  await request("destroy").catch(() => undefined);
  if (driver.exitCode === null) driver.kill("SIGTERM");
}
