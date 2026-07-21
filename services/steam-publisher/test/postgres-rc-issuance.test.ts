import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { runnerArtifactObjectKey } from "../../evidence-archive/src/runner-artifacts";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { signSteamRcArtifact } from "../src/artifacts";
import { PostgresSteamRcArtifactArchive, PostgresSteamRcIssuanceAuthority } from "../src/postgres-rc-issuance";
import type { SteamPrivateBetaOperationRequest } from "../src/workflow-broker-http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const releaseId = "44444444-4444-4444-8444-444444444444";
const evidenceId = "55555555-5555-4555-8555-555555555555";
const attemptId = "66666666-6666-4666-8666-666666666666";
const mfaId = "77777777-7777-4777-8777-777777777777";
const depotConfigurationId = "88888888-8888-4888-8888-888888888888";
const artifactId = "99999999-9999-4999-8999-999999999999";
const mainCommitSha = "a".repeat(40);
const sourceDigest = "b".repeat(64);
const steamAppId = "2841930";
const request: SteamPrivateBetaOperationRequest = Object.freeze({
  schemaVersion: "deviludo.steam-workflow.v1",
  kind: "PRIVATE_BETA_UPLOAD",
  operationKey: "workflow-job:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  requestDigest: "c".repeat(64),
  tenantId,
  projectId,
  workflowId: "delivery-001",
  runId,
  mainCommitSha,
  mainEvidenceBundleId: evidenceId,
  mfaApprovalId: mfaId,
  targetMatrix: Object.freeze(["linux", "windows"] as const),
});
const platformEvidence = Object.freeze([
  evidenceFor("linux", "runner-linux", "1"),
  evidenceFor("windows", "runner-windows", "8"),
]);
const evidenceCore = Object.freeze({
  id: evidenceId,
  attemptId,
  specRevisionId: "spec-revision-11",
  specDigest: "2".repeat(64),
  testPlanDigest: "3".repeat(64),
  commitSha: mainCommitSha,
  sourceDigest,
  targetMatrix: request.targetMatrix,
  godotTestKitDigest: "4".repeat(64),
  buildManifestDigest: "5".repeat(64),
  sbomDigest: "6".repeat(64),
  vulnerabilityScanDigest: "7".repeat(64),
  assetLicenseLedgerDigest: "9".repeat(64),
  platformEvidence,
  status: "PASSED",
  valid: true,
  createdAt: "2030-01-01T00:00:00.000Z",
});
const evidenceBundleDigest = sha256Canonical(evidenceCore);
const evidenceManifest = Object.freeze({ ...evidenceCore, bundleDigest: evidenceBundleDigest });
const platformDepots = Object.freeze({ linux: "2841931", windows: "2841932" });
const depotConfigurationDigest = sha256Canonical({
  schemaVersion: "deviludo.steam-depot-configuration.v1",
  steamAppId,
  platformDepots,
});
const authorityRow = Object.freeze({
  release_id: releaseId,
  release_main_commit_sha: mainCommitSha,
  release_steam_app_id: steamAppId,
  release_evidence_bundle_id: evidenceId,
  release_mfa_approval_id: mfaId,
  evidence_bundle_digest: evidenceBundleDigest,
  evidence_source_digest: sourceDigest,
  evidence_manifest: evidenceManifest,
  evidence_status: "PASSED",
  evidence_invalidated_at: null,
  attempt_id: attemptId,
  attempt_run_id: runId,
  attempt_mode: "MAIN_RELEASE_GATE",
  attempt_state: "PASSED",
  depot_configuration_id: depotConfigurationId,
  depot_configuration_steam_app_id: steamAppId,
  depot_configuration_platform_depots: platformDepots,
  depot_configuration_digest: depotConfigurationDigest,
});

class Client implements PostgresWorkflowClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  authorityRow: Record<string, unknown> = authorityRow;
  artifactRow: Record<string, unknown> | null = null;
  releases = 0;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.includes("FROM deviludo.steam_releases release")) return result([this.authorityRow] as Row[]);
    if (text.includes("INSERT INTO deviludo.steam_rc_artifacts")) {
      if (!this.artifactRow) this.artifactRow = {
        id: String(values[0]), tenant_id: String(values[1]), project_id: String(values[2]), run_id: String(values[3]),
        release_id: String(values[4]), main_evidence_bundle_id: String(values[5]),
        depot_configuration_id: String(values[6]), depot_configuration_digest: String(values[7]),
        artifact_digest: String(values[8]), signed_artifact: JSON.parse(String(values[9])), created_at: String(values[10]),
      };
      return result([], 1);
    }
    if (text.includes("FROM deviludo.steam_rc_artifacts")) {
      return this.artifactRow ? result([this.artifactRow] as Row[]) : result([]);
    }
    if (text === "SELECT 1 AS ready") return result([{ ready: 1 }] as unknown as Row[]);
    return result([]);
  }

  release(): void { this.releases += 1; }
}

function pool(client: Client) { return { async connect() { return client; } }; }

test("PostgreSQL RC authority binds passed merged-main evidence to one active depot revision under RLS", async () => {
  const client = new Client();
  const authority = new PostgresSteamRcIssuanceAuthority(pool(client));
  const snapshot = await authority.resolve(request);
  assert.equal(snapshot.releaseId, releaseId);
  assert.equal(snapshot.evidenceBundleDigest, evidenceBundleDigest);
  assert.equal(snapshot.depotConfigurationDigest, depotConfigurationDigest);
  assert.deepEqual(snapshot.depots, request.targetMatrix.map((platform, index) => ({
    platform,
    depotId: (platformDepots as Readonly<Record<string, string>>)[platform],
    objectKey: runnerArtifactObjectKey(
      tenantId, projectId, attemptId, platform, "production-export", platformEvidence[index]!.exportDigest,
    ),
    artifactDigest: platformEvidence[index]!.exportDigest,
  })));
  const query = client.calls.find((call) => call.text.includes("steam_releases release"))!;
  assert.deepEqual(query.values, [tenantId, projectId, mainCommitSha, evidenceId, mfaId, runId]);
  assert.match(query.text, /depot\.id = release_configuration\.depot_configuration_id/);
  assert.match(query.text, /attempt\.mode = 'MAIN_RELEASE_GATE'/);
  assert.ok(client.calls.some((call) => call.text.includes("set_config('app.tenant_id'")));

  client.authorityRow = { ...authorityRow, evidence_manifest: { ...evidenceManifest, sourceDigest: "f".repeat(64) } };
  await assert.rejects(authority.resolve(request), /RC issuance authority is invalid/);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
});

test("PostgreSQL RC archive replays only the exact signed artifact and frozen depot revision", async () => {
  const client = new Client();
  const authority = new PostgresSteamRcIssuanceAuthority(pool(client));
  const snapshot = await authority.resolve(request);
  const key = generateKeyPairSync("ed25519");
  const artifact = signSteamRcArtifact("steam-rc-kms-9", key.privateKey, {
    kind: "deviludo-steam-rc",
    version: 2,
    tenantId,
    projectId,
    releaseId,
    mainCommitSha,
    sourceDigest,
    specRevisionId: evidenceCore.specRevisionId,
    specDigest: evidenceCore.specDigest,
    testPlanDigest: evidenceCore.testPlanDigest,
    evidenceBundleDigest,
    steamAppId,
    targetMatrix: request.targetMatrix,
    depots: Object.freeze(snapshot.depots.map((depot) => Object.freeze({
      depotId: depot.depotId,
      platform: depot.platform,
      objectRef: `s3://deviludo-evidence/signed/${depot.platform}`,
      sourceArtifactDigest: depot.artifactDigest,
      artifactDigest: (depot.platform === "linux" ? "8" : "9").repeat(64),
      sizeBytes: 4_096,
      signingScheme: depot.platform === "windows" ? "WINDOWS_AUTHENTICODE" as const
        : depot.platform === "macos" ? "MACOS_DEVELOPER_ID" as const : "LINUX_SIGSTORE" as const,
      signingIdentityDigest: "a".repeat(64),
      signingEvidenceRef: `s3://deviludo-evidence/signing/${depot.platform}.json`,
      signingEvidenceDigest: "b".repeat(64),
      notarizationEvidenceRef: depot.platform === "macos" ? "s3://deviludo-evidence/notary/macos.json" : null,
      notarizationEvidenceDigest: depot.platform === "macos" ? "c".repeat(64) : null,
    }))),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
  });
  const archive = new PostgresSteamRcArtifactArchive(pool(client));
  const input = {
    artifactId,
    snapshot,
    artifactDigest: sha256Canonical(artifact),
    artifact,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
  assert.deepEqual((await archive.persist(input)).artifact, artifact);
  assert.deepEqual(await archive.find({ tenantId, releaseId }), await archive.persist(input));
  assert.match(client.calls.find((call) => call.text.includes("INSERT INTO deviludo.steam_rc_artifacts"))!.text,
    /ON CONFLICT \(tenant_id, release_id\) DO NOTHING/);
  assert.doesNotMatch(JSON.stringify(client.calls), /private.?key|accountPassword|configVdf/i);

  await assert.rejects(archive.persist({
    ...input,
    snapshot: { ...snapshot, depotConfigurationDigest: "f".repeat(64) },
  }), /RC issuance authority is invalid/);
});

function evidenceFor(platform: "linux" | "windows", runnerId: string, seed: string) {
  return Object.freeze({
    platform,
    runnerId,
    runnerCapabilityDigest: digest(`${seed}:capability`),
    exportDigest: digest(`${seed}:export`),
    logsDigest: digest(`${seed}:logs`),
    junitDigest: digest(`${seed}:junit`),
    inputTimelineDigest: digest(`${seed}:timeline`),
    screenshotManifestDigest: digest(`${seed}:screenshots`),
    videoManifestDigest: digest(`${seed}:video`),
    status: "PASSED",
  });
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function result<Row extends Record<string, unknown>>(rows: Row[], rowCount = rows.length): PostgresQueryResult<Row> {
  return { rows, rowCount };
}
