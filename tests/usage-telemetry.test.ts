import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoreConfig } from "../services/core/src/config";
import { UsageTelemetry } from "../services/core/src/usage-telemetry";

function config(root: string, endpoint: string | null, enabled = true): CoreConfig {
  return {
    projectsRoot: root,
    telemetryEndpoint: endpoint,
    telemetryEnabled: enabled,
    releaseVersion: "v1.2.3",
  } as CoreConfig;
}

test("telemetry stores an opaque installation ID and sends only the disclosed active-installation fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-telemetry-"));
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const telemetry = new UsageTelemetry(config(root, "https://telemetry.example/active"));
    const before = await telemetry.settings();
    assert.equal(before.enabled, true);
    assert.equal(before.endpointConfigured, true);
    assert.deepEqual(before.collectedFields, ["installationId", "activeDay", "releaseVersion", "operatingSystem", "architecture"]);
    telemetry.recordActivity();
    await waitFor(async () => (await telemetry.settings()).lastReportedAt !== null);
    assert.ok(payload);
    const reported = payload as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(reported).sort(), [
      "activeDay", "architecture", "event", "installationId", "operatingSystem", "releaseVersion",
    ]);
    assert.equal(reported.event, "ACTIVE_INSTALLATION");
    assert.equal(reported.releaseVersion, "v1.2.3");
    const persisted = JSON.parse(await readFile(join(root, ".deviludo-telemetry.json"), "utf8")) as Record<string, unknown>;
    assert.match(String(persisted.installationId), /^[0-9a-f-]{36}$/i);
    assert.equal(persisted.enabled, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled or unconfigured telemetry never performs a request", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-telemetry-off-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response(null, { status: 204 }); }) as typeof fetch;
  try {
    const unconfigured = new UsageTelemetry(config(root, null));
    unconfigured.recordActivity();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 0);
    const disabled = new UsageTelemetry(config(root, "https://telemetry.example/active"));
    await disabled.setEnabled(false);
    disabled.recordActivity();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("telemetry report did not complete");
}
