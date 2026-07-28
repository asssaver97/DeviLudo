import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  deployAgentWorkerHost,
  parseAgentHostDeploymentArguments,
  parseAgentWorkerEnvironment,
  renderAgentWorkerSystemdUnit,
} from "../scripts/production/deploy-agent-worker-host.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("Agent host one-click input is digest-bound and its unit exposes no environment values", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-host-deploy-"));
  try {
    const artifact = "/opt/deviludo/bin/deviludo-agent-execution-worker-native.mjs";
    const envFile = resolve(root, "agent-worker.env");
    const envBytes = Buffer.from([
      "NODE_ENV=production",
      `DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_FILE=${artifact}`,
      `DEVILUDO_AGENT_EXECUTION_WORKER_NATIVE_ARTIFACT_DIGEST=${"a".repeat(64)}`,
      "DEVILUDO_TEST_SECRET=must-not-appear-in-unit",
      "",
    ].join("\n"));
    await writeFile(envFile, envBytes, { mode: 0o600 }); await chmod(envFile, 0o600);
    const receiptPath = resolve(root, "agent-worker-receipt.json");
    const configPath = resolve(root, "agent-worker-deployment.json");
    const config = {
      schemaVersion: "deviludo.agent-worker-host-deployment.v1",
      environmentFile: envFile,
      environmentFileDigest: digest(envBytes),
      receiptPath,
    };
    const configBytes = Buffer.from(`${JSON.stringify(config)}\n`);
    await writeFile(configPath, configBytes, { mode: 0o644 });
    const options = { apply: true, configPath, configDigest: digest(configBytes) };
    const units = new Map(); const commands = [];
    const host = {
      async preflight() {},
      async readUnit(path) { return units.has(path) ? Buffer.from(units.get(path)) : null; },
      async writeUnit(path, body) { units.set(path, Buffer.from(body)); },
      async removeUnit(path) { units.delete(path); },
      async run(command, args) { commands.push([command, ...args]); return { exitCode: 0 }; },
    };
    const result = await deployAgentWorkerHost(options, {
      host,
      verifyNative: async () => ({ releaseId: "worker-release-01" }),
      verifyMicrovm: async () => ({ launcher: { releaseId: "launcher-release-01" }, guest: {
        releaseId: "guest-release-01", agent: "claude-code", exactAgentVersion: "2.1.14",
        adapterVersion: "1.3.0", workerImageDigest: `sha256:${"b".repeat(64)}`,
      } }),
      loadBinding: async () => ({ schemaVersion: "deviludo.agent-execution-worker-binding.v1",
        workerPool: "development-linux-primary", installationIds: ["claude-install-01"], agent: "claude-code",
        exactAgentVersion: "2.1.14", adapterVersion: "1.3.0", workerImageDigest: `sha256:${"b".repeat(64)}` }),
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    assert.equal(result.receipt.state, "SERVICE_STARTED");
    assert.ok(commands.some((call) => call.includes("restart")));
    const rendered = units.get("/etc/systemd/system/deviludo-agent-execution-worker.service").toString();
    assert.match(rendered, /EnvironmentFile=/);
    assert.match(rendered, /DeviceAllow=\/dev\/kvm rw/);
    assert.doesNotMatch(rendered, /must-not-appear|DEVILUDO_TEST_SECRET/);
    assert.doesNotMatch(await readFile(receiptPath, "utf8"), /must-not-appear/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Agent host parser rejects insecure or ambiguous inputs", () => {
  const parsed = parseAgentHostDeploymentArguments([
    "--config", "/etc/deviludo/agent-host.json", "--config-digest", "a".repeat(64), "--apply",
  ]);
  assert.equal(parsed.apply, true);
  assert.equal(parseAgentWorkerEnvironment(Buffer.from("NODE_ENV=production\nA_VALUE=ok\n")).A_VALUE, "ok");
  assert.throws(() => parseAgentWorkerEnvironment(Buffer.from("NODE_ENV=development\n")), /input is invalid/);
  const unit = renderAgentWorkerSystemdUnit("/opt/deviludo/bin/worker", "/etc/deviludo/worker.env");
  assert.match(unit, /User=root/);
  assert.throws(() => renderAgentWorkerSystemdUnit("/opt/deviludo/bin/worker bad", "/etc/deviludo/worker.env"), /input is invalid/);
});
