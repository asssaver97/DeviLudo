import assert from "node:assert/strict";
import test from "node:test";
import { MtlsRunnerSteamInstallPreparationClient } from "../src/steam-install-preparation-client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const sha = (value: string) => value.repeat(64);
const tls = { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) };
const input = Object.freeze({
  tenantId,
  projectId,
  runId,
  lockKey: sha("a"),
  commitSha: "b".repeat(40),
  steamBuildId: "91234567",
  targetMatrix: Object.freeze(["linux", "macos", "windows"] as const),
});

function receipt() {
  return {
    schemaVersion: "deviludo.steam-clean-install-preparation-receipt.v1",
    executionLockId: "44444444-4444-4444-8444-444444444444",
    executionLockDigest: sha("c"),
    sourceDigest: sha("d"),
    steamAppId: "480",
    buildId: input.steamBuildId,
    betaBranch: "private_beta",
    installGrantId: "steam-install-grant-001",
    targetMatrix: [...input.targetMatrix],
    created: true,
  };
}

test("Runner Steam Preparer sends no account secret and accepts one exact BuildID-bound lock", async () => {
  const client = new MtlsRunnerSteamInstallPreparationClient({
    endpoint: "https://steam-broker.internal:4743",
    tls,
    timeoutMs: 30_000,
    async http(request) {
      assert.equal(request.url.href, "https://steam-broker.internal:4743/v1/clean-install-execution-preparations");
      assert.equal(request.timeoutMs, 30_000);
      const body = JSON.parse(request.body) as Record<string, unknown>;
      assert.deepEqual(body, {
        schemaVersion: "deviludo.steam-clean-install-preparation-trigger.v1",
        ...input,
        targetMatrix: [...input.targetMatrix],
      });
      assert.ok(!JSON.stringify(body).includes("password"));
      assert.ok(!JSON.stringify(body).includes("config.vdf"));
      return { statusCode: 200, payload: receipt() };
    },
  });
  const { schemaVersion, ...expected } = receipt();
  assert.equal(schemaVersion, "deviludo.steam-clean-install-preparation-receipt.v1");
  assert.deepEqual(await client.prepare(input), expected);
});

test("Runner Steam Preparer rejects BuildID, branch, receipt and endpoint drift", async () => {
  assert.throws(() => new MtlsRunnerSteamInstallPreparationClient({ endpoint: "http://steam.internal", tls }), /URL is invalid/);
  const rejected = new MtlsRunnerSteamInstallPreparationClient({
    endpoint: "https://steam.internal",
    tls,
    async http() { return { statusCode: 409, payload: {} }; },
  });
  await assert.rejects(rejected.prepare(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RUNNER_STEAM_INSTALL_PREPARATION_REJECTED");
    assert.equal((error as { terminal?: boolean }).terminal, true);
    return true;
  });
  const tampered = new MtlsRunnerSteamInstallPreparationClient({
    endpoint: "https://steam.internal",
    tls,
    async http() { return { statusCode: 200, payload: { ...receipt(), buildId: "999", betaBranch: "default" } }; },
  });
  await assert.rejects(tampered.prepare(input), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RUNNER_STEAM_INSTALL_PREPARATION_RECEIPT_INVALID");
    return true;
  });
});
