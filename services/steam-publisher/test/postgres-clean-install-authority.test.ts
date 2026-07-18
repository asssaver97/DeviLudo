import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresSteamCleanInstallPreparationAuthority } from "../src/postgres-clean-install-authority";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const specRevisionId = "44444444-4444-4444-8444-444444444444";
const toolchainRevisionId = "55555555-5555-4555-8555-555555555555";
const buildReceiptId = "66666666-6666-4666-8666-666666666666";
const sha = (character: string) => character.repeat(64);
const matrix = Object.freeze(["linux", "macos", "windows"] as const);
const specPayload = Object.freeze({ schemaVersion: "deviludo.game-spec.v1", title: "Ember Harbor" });
const toolchainPayload = Object.freeze({
  schemaVersion: "deviludo.runner-toolchain.v1",
  requiredGodotVersion: "4.6.2-stable",
  godotTestKitDigest: sha("1"),
  exportTemplates: Object.freeze({ linux: sha("2"), macos: sha("3"), windows: sha("4") }),
  buildManifestDigest: sha("5"),
  sbomDigest: sha("6"),
  vulnerabilityScanDigest: sha("7"),
  assetLicenseLedgerDigest: sha("8"),
});
const specDigest = sha256Canonical(specPayload);
const toolchainDigest = sha256Canonical(toolchainPayload);
const testPlanDigest = sha("9");
const commitSha = "a".repeat(40);
const sourceDigest = sha("b");
const evidenceDigest = sha("c");
const trigger = Object.freeze({
  schemaVersion: "deviludo.steam-clean-install-preparation-trigger.v1" as const,
  tenantId, projectId, runId, lockKey: sha("d"), commitSha,
  steamBuildId: "91234567", targetMatrix: matrix,
});

test("PostgreSQL Steam authority resolves only a passed immutable main gate under tenant RLS", async () => {
  const calls: { text: string; values?: readonly unknown[] }[] = [];
  let released = false;
  const client = clientFor(row(), calls, () => { released = true; });
  const authority = new PostgresSteamCleanInstallPreparationAuthority({ async connect() { return client; } });
  const resolved = await authority.resolve(trigger);
  assert.equal(calls[0]?.text, "BEGIN");
  assert.equal(calls[1]?.text, "SELECT set_config('app.tenant_id', $1, true)");
  assert.deepEqual(calls[1]?.values, [tenantId]);
  assert.match(calls[2]?.text ?? "", /main_attempt\.mode = 'MAIN_RELEASE_GATE'/);
  assert.match(calls[2]?.text ?? "", /main_evidence\.invalidated_at IS NULL/);
  assert.equal(calls.at(-1)?.text, "COMMIT");
  assert.equal(released, true);
  assert.equal(resolved.buildReceiptId, buildReceiptId);
  assert.equal(resolved.sourceDigest, sourceDigest);
  assert.equal(resolved.runnerToolchainDigest, toolchainDigest);
  assert.deepEqual(resolved.trigger.targetMatrix, matrix);
  assert.doesNotMatch(JSON.stringify(resolved), /config\.vdf|password|steam.?guard|secret.?ref/i);
});

test("PostgreSQL Steam authority rejects source, toolchain, install-attempt and gate drift", async () => {
  for (const changed of [
    { main_evidence_source_digest: sha("f") },
    { toolchain_payload_digest: sha("e") },
    { install_attempts: { linux: "install-linux", windows: "install-windows" } },
    { main_attempt_state: "FAILED" },
  ]) {
    const authority = new PostgresSteamCleanInstallPreparationAuthority({
      async connect() { return clientFor({ ...row(), ...changed }, [], () => {}); },
    });
    await assert.rejects(authority.resolve(trigger), /authority receipt is invalid/);
  }
});

function row() {
  return {
    run_id: runId,
    configuration_lock: {
      specRevisionId, specDigest, testPlanDigest,
      runnerToolchainRevisionId: toolchainRevisionId,
      runnerToolchainDigest: toolchainDigest,
      targetMatrix: matrix,
    },
    spec_revision_id: specRevisionId,
    spec_payload: specPayload,
    spec_digest: specDigest,
    test_plan_digest: testPlanDigest,
    target_matrix: matrix,
    required_godot_version: toolchainPayload.requiredGodotVersion,
    runner_toolchain_revision_id: toolchainRevisionId,
    runner_toolchain_digest: toolchainDigest,
    toolchain_payload: toolchainPayload,
    toolchain_payload_digest: toolchainDigest,
    main_attempt_mode: "MAIN_RELEASE_GATE",
    main_attempt_state: "PASSED",
    main_attempt_commit_sha: commitSha,
    main_attempt_source_digest: sourceDigest,
    main_attempt_target_matrix: matrix,
    main_evidence_status: "PASSED",
    main_evidence_commit_sha: commitSha,
    main_evidence_source_digest: sourceDigest,
    main_evidence_bundle_digest: evidenceDigest,
    main_evidence_invalidated_at: null,
    release_main_commit_sha: commitSha,
    release_steam_app_id: "2841930",
    build_receipt_id: buildReceiptId,
    build_steam_app_id: "2841930",
    build_id: trigger.steamBuildId,
    build_main_commit_sha: commitSha,
    build_source_digest: sourceDigest,
    build_evidence_bundle_digest: evidenceDigest,
    beta_branch: "deviludo_private_9",
    install_attempts: { linux: "install-linux", macos: "install-macos", windows: "install-windows" },
    build_state: "INSTALL_TESTING",
  };
}

function clientFor(
  authorityRow: Record<string, unknown>,
  calls: { text: string; values?: readonly unknown[] }[],
  release: () => void,
): PostgresWorkflowClient {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
      calls.push({ text, values });
      if (text.includes("FROM deviludo.steam_build_receipts")) return { rowCount: 1, rows: [authorityRow as Row] };
      return { rowCount: null, rows: [] };
    },
    release,
  };
}
