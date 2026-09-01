#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const MAX_INTERACTION_EVENTS = 512;
const [command] = process.argv.slice(2);
const value = name => { const index = process.argv.indexOf(name); if (index < 0) throw new Error(`missing ${name}`); return process.argv[index + 1]; };
const pid = value("--pid");
const x11Key = value => {
  const key = value.replace(/^KEY_/, "");
  const fixed = { SPACE: "space", ENTER: "Return", TAB: "Tab", ESCAPE: "Escape", LEFT: "Left", RIGHT: "Right", UP: "Up", DOWN: "Down", MINUS: "minus", EQUAL: "equal" };
  if (fixed[key]) return fixed[key];
  if (/^[A-Z]$/.test(key)) return key.toLowerCase();
  if (/^[0-9]$/.test(key)) return key;
  throw new Error("unsupported keyboard input");
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const mouseButton = button => button === "RIGHT" ? "3" : button === "MIDDLE" ? "2" : "1";
async function sendEvent(event, windowId) {
  if (event.type === "wait") return;
  if (event.type === "key_press") await execute("xdotool", ["keydown", x11Key(event.key)]);
  else if (event.type === "key_release") await execute("xdotool", ["keyup", x11Key(event.key)]);
  else if (event.type === "mouse_move") await execute("xdotool", ["mousemove", "--window", windowId, String(event.x), String(event.y)]);
  else if (event.type === "mouse_click") await execute("xdotool", ["click", mouseButton(event.button)]);
  else if (event.type === "mouse_down") await execute("xdotool", ["mousedown", mouseButton(event.button)]);
  else if (event.type === "mouse_up") await execute("xdotool", ["mouseup", mouseButton(event.button)]);
  else if (event.type === "scroll") {
    const button = event.deltaY > 0 ? "4" : "5";
    const count = Math.max(1, Math.min(100, Math.ceil(Math.abs(event.deltaY) / 120)));
    await execute("xdotool", ["click", "--repeat", String(count), button]);
  } else if (event.type === "text_input") await execute("xdotool", ["type", "--clearmodifiers", "--", event.text]);
  else throw new Error("unsupported X11 input event");
}
const { stdout } = await execute("xdotool", ["search", "--sync", "--onlyvisible", "--pid", pid], { timeout: 30_000 });
const windowId = stdout.trim().split(/\s+/)[0];
if (!windowId) throw new Error("display unavailable: game window did not appear");
await execute("xdotool", ["windowactivate", "--sync", windowId]);
if (command === "wait") await execute("xdotool", ["windowsize", "--sync", windowId, value("--width"), value("--height")]);
else if (command === "event") {
  const event = JSON.parse(value("--event"));
  await sendEvent(event, windowId);
} else if (command === "sequence") {
  const events = JSON.parse(value("--events"));
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_INTERACTION_EVENTS) {
    throw new Error("input sequence is invalid");
  }
  // Recover earlier xdotool and X11 overhead on the next wait instead of
  // accumulating it across a timing-sensitive journey.
  const startedAt = performance.now();
  let dueOffsetMs = 0;
  for (const event of events) {
    const delayMs = event.delay_ms ?? 0;
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 300_000) throw new Error("input sequence delay is invalid");
    dueOffsetMs += delayMs;
    const remainingMs = startedAt + dueOffsetMs - performance.now();
    if (remainingMs > 0) await delay(remainingMs);
    await sendEvent(event, windowId);
  }
} else if (command === "capture") await execute("import", ["-window", windowId, `png:${value("--output")}`], { timeout: 30_000 });
else throw new Error("unsupported command");
process.stdout.write(JSON.stringify({ ok: true, pid: Number(pid), windowId, width: 1280, height: 720, capturedAt: new Date().toISOString() }));
