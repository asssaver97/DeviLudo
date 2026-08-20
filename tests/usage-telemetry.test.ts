import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TELEMETRY_ENDPOINT, type CoreConfig } from "../services/core/src/config";
import { UsageTelemetry } from "../services/core/src/usage-telemetry";

const MACHINE_INSTALLATION_ID = "01234567-89ab-5def-8abc-0123456789ab";

function config(root: string, endpoint: string | null): CoreConfig {
  return {
    projectsRoot: root,
    telemetryEndpoint: endpoint,
    installationId: MACHINE_INSTALLATION_ID,
    releaseVersion: "v1.2.3",
  } as CoreConfig;
}

test("telemetry stores an opaque installation ID and sends only the disclosed active-installation fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-telemetry-"));
  const originalFetch = globalThis.fetch;
  let target = "";
  let payload: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input, init) => {
    target = String(input);
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const telemetry = new UsageTelemetry(config(root, DEFAULT_TELEMETRY_ENDPOINT));
    const before = await telemetry.status();
    assert.equal(before.endpointConfigured, true);
    assert.deepEqual(before.collectedFields, ["installationId", "activeDay", "releaseVersion", "operatingSystem", "architecture"]);
    telemetry.recordActivity();
    await waitFor(async () => (await telemetry.status()).lastReportedAt !== null);
    assert.ok(payload);
    assert.equal(target, DEFAULT_TELEMETRY_ENDPOINT);
    const reported = payload as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(reported).sort(), [
      "activeDay", "architecture", "event", "installationId", "operatingSystem", "releaseVersion",
    ]);
    assert.equal(reported.event, "ACTIVE_INSTALLATION");
    assert.equal(reported.releaseVersion, "v1.2.3");
    assert.equal(reported.installationId, MACHINE_INSTALLATION_ID);
    const persisted = JSON.parse(await readFile(join(root, ".deviludo-telemetry.json"), "utf8")) as Record<string, unknown>;
    assert.match(String(persisted.installationId), /^[0-9a-f-]{36}$/i);
    assert.deepEqual(Object.keys(persisted).sort(), ["installationId", "lastReportedAt"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("telemetry replaces a deployment-scoped legacy ID with the machine ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-telemetry-migrate-"));
  const legacyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    await writeFile(join(root, ".deviludo-telemetry.json"), `${JSON.stringify({
      installationId: legacyId,
      lastReportedAt: new Date().toISOString(),
    })}\n`);
    const status = await new UsageTelemetry(config(root, DEFAULT_TELEMETRY_ENDPOINT)).status();
    assert.equal(status.installationIdMask, `${MACHINE_INSTALLATION_ID.slice(0, 8)}…`);
    assert.equal(status.lastReportedAt, null);
    const migrated = JSON.parse(await readFile(join(root, ".deviludo-telemetry.json"), "utf8")) as Record<string, unknown>;
    assert.equal(migrated.installationId, MACHINE_INSTALLATION_ID);
    assert.equal(migrated.lastReportedAt, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfigured telemetry never performs a request", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-telemetry-off-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response(null, { status: 204 }); }) as typeof fetch;
  try {
    const unconfigured = new UsageTelemetry(config(root, null));
    unconfigured.recordActivity();
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
