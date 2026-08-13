import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GameTestEnvironment, gamepadEventCount } from "../scripts/executors/game-test-environment.mjs";

test("GameTestEnvironment creates the system gamepad before launch and neutralizes it on cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-game-env-"));
  const executable = join(root, "fake-gamepad.mjs");
  const log = join(root, "gamepad.jsonl");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const log = ${JSON.stringify(log)};
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const value = JSON.parse(line); await appendFile(log, JSON.stringify(value) + "\\n");
  process.stdout.write(JSON.stringify({ id: value.id, ok: true }) + "\\n");
  if (value.command === "destroy") break;
}
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const desktop: { command: string; args: string[] }[] = [];
  const environment = new GameTestEnvironment({
    pid: null,
    runId: "mixed-input",
    workspace: root,
    gamepadDriver: executable,
    useGamepad: true,
    driver: async (command: string, args: string[]) => { desktop.push({ command, args }); },
  });
  try {
    await environment.prepareInputDevices();
    environment.attach(12345);
    const events = [
      { type: "key_tap", key: "SPACE" },
      { type: "gamepad_button_tap", button: "A" },
      { type: "click", x: 10, y: 20 },
    ];
    await environment.sequence(events, 5_000);
    assert.equal(gamepadEventCount(events), 1);
    assert.deepEqual(desktop.map(item => item.command), ["sequence", "sequence"]);
    assert.equal(JSON.parse(desktop[0]!.args.at(-1)!).length, 1);
  } finally {
    await environment.close();
  }
  const commands = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line).command);
  assert.deepEqual(commands, ["ready", "sequence", "release_all", "destroy"]);
  await rm(root, { recursive: true, force: true });
});

test("GameTestEnvironment refuses gamepad actions when no system device was created", async () => {
  const environment = new GameTestEnvironment({
    pid: 12345,
    runId: "no-gamepad",
    workspace: tmpdir(),
    useGamepad: false,
    driver: async () => undefined,
  });
  await assert.rejects(environment.sequence([{ type: "gamepad_button_tap", button: "A" }], 1_000), /without a virtual device/i);
});
