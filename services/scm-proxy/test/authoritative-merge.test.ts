import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { MtlsCandidateAcceptanceSigner } from "../src/acceptance-signer-client";
import { sha256Canonical } from "../src/canonical";
import { signCandidateAcceptance } from "../src/github-artifacts";
import type { GitHubCandidateReceipt, GitHubMergeReceipt, GitHubRepositoryBinding } from "../src/github-contracts";
import { createScmMergeHandler } from "../src/merge-http";
import { AuthoritativeScmMergeService, type AuthoritativeMergeContext, type ScmMergeCommand } from "../src/merge-service";
import { PostgresScmMergeStore } from "../src/postgres-merge";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const specRevisionId = "44444444-4444-4444-8444-444444444444";
const evidenceBundleId = "55555555-5555-4555-8555-555555555555";
const candidateReceiptId = "66666666-6666-4666-8666-666666666666";
const repositoryBindingId = "77777777-7777-4777-8777-777777777777";
const mergeReceiptId = "88888888-8888-4888-8888-888888888888";
const candidateCommitSha = "a".repeat(40);
const sourceDigest = "b".repeat(64);
const evidenceDigest = "c".repeat(64);
const acceptanceOperationKey = "d".repeat(64);
const keys = generateKeyPairSync("ed25519");

function command(): ScmMergeCommand { return Object.freeze({ schemaVersion: "deviludo.scm-merge.v1",
  operationKey: "workflow-job:99999999-9999-4999-8999-999999999999", requestDigest: "e".repeat(64),
  tenantId, projectId, workflowId: "delivery-001", runId, specRevisionId, candidateCommitSha,
  pullRequestNumber: 42, evidenceBundleId, acceptanceSignalId: "accepted-signal-001" }); }
function binding(): GitHubRepositoryBinding { return Object.freeze({ tenantId, projectId, installationId: "12345",
  repositoryId: 98_765, repositoryNodeId: "R_repo", owner: "deviludo", name: "game", defaultBranch: "main" }); }
function candidate(): GitHubCandidateReceipt { return Object.freeze({ scmProxy: "github-app-proxy-v1", tenantId, projectId,
  installationId: "12345", repositoryId: 98_765, repositoryNodeId: "R_repo", artifactId: "artifact-1",
  artifactDigest: "f".repeat(64), baseBranch: "main", baseCommitSha: "0".repeat(40), candidateBranch: "deviludo/project/run",
  candidateCommitSha, sourceDigest, changedFiles: ["project.godot"], pullRequestNumber: 42, pullRequestNodeId: "PR_node",
  pullRequestUrl: "https://github.com/deviludo/game/pull/42", state: "DRAFT", createdAt: "2030-01-01T00:00:00.000Z" }); }
function authority(): AuthoritativeMergeContext { return Object.freeze({ acceptanceOperationKey, acceptedBy: "github-user-1",
  acceptedAt: "2030-01-01T00:01:00.000Z", repositoryBindingId, binding: binding(), candidateReceiptId, candidate: candidate(),
  evidence: Object.freeze({ evidenceBundleId, evidenceBundleDigest: evidenceDigest, candidateCommitSha, sourceDigest,
    specRevisionId, status: "PASSED", valid: true }) }); }
function merged(): GitHubMergeReceipt { return Object.freeze({ scmProxy: "github-app-proxy-v1", tenantId, projectId,
  repositoryNodeId: "R_repo", pullRequestNumber: 42, candidateCommitSha, mergeCommitSha: "1".repeat(40), defaultBranch: "main",
  defaultBranchHeadSha: "1".repeat(40), mainSourceDigest: "2".repeat(64), requiresFreshMainSnapshot: false,
  acceptanceNonce: acceptanceOperationKey, evidenceBundleDigest: evidenceDigest, mergedAt: "2030-01-01T00:02:00.000Z" }); }

test("authoritative merge signs only resolved authority and archives the observed main head", async () => {
  const calls: string[] = [];
  const service = new AuthoritativeScmMergeService({ async resolve() { calls.push("authority"); return authority(); },
    async verify() { return true; }, async probe() {} }, {
    async sign(claims) { calls.push("sign"); assert.equal(claims.acceptedBy, "github-user-1");
      assert.equal(claims.nonce, acceptanceOperationKey); return signCandidateAcceptance(claims, keys.privateKey, "acceptance-v1"); }, async probe() {},
  }, { async mergeAcceptedCandidate(request) { calls.push("github"); assert.equal(request.acceptance.claims.evidenceBundleDigest, evidenceDigest); return merged(); } },
  { async persist(input) { calls.push("archive"); assert.equal(input.request.acceptanceSignalId, "accepted-signal-001"); return { receiptId: mergeReceiptId }; }, async probe() {} },
  () => new Date("2030-01-01T00:02:00.000Z"));
  const receipt = await service.merge(command());
  assert.equal(receipt.receiptId, mergeReceiptId); assert.equal(receipt.defaultBranchHeadSha, "1".repeat(40));
  assert.deepEqual(calls, ["authority", "sign", "github", "archive"]);
});

test("acceptance signer sends canonical claims to KMS and verifies the returned proof", async () => {
  const claims = Object.freeze({ iss: "deviludo-control-plane" as const, aud: "deviludo-scm-proxy" as const,
    tenantId, projectId, acceptedBy: "github-user-1", candidateCommitSha, sourceDigest, specRevisionId,
    evidenceBundleDigest: evidenceDigest, iat: 1_893_456_000, exp: 1_893_456_300, nonce: acceptanceOperationKey });
  const observed: string[] = [];
  const signer = new MtlsCandidateAcceptanceSigner({ endpoint: "https://kms.internal/", keyId: "acceptance-v1",
    publicKey: keys.publicKey, tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    http: async ({ url, body }) => { observed.push(url.pathname); if (url.pathname === "/healthz") return { statusCode: 200,
      payload: { schemaVersion: "deviludo.github-candidate-acceptance-signer-health.v1", status: "ok", keyId: "acceptance-v1", algorithm: "Ed25519" } };
      const request = JSON.parse(body) as { claims: typeof claims; claimsDigest: string }; return { statusCode: 200, payload: {
        schemaVersion: "deviludo.github-candidate-acceptance-sign-receipt.v1", keyId: "acceptance-v1", algorithm: "Ed25519",
        claimsDigest: request.claimsDigest, acceptance: signCandidateAcceptance(request.claims, keys.privateKey, "acceptance-v1") } }; },
  });
  await signer.probe(); const proof = await signer.sign(claims);
  assert.equal(proof.claims.nonce, acceptanceOperationKey);
  assert.deepEqual(observed, ["/healthz", "/v1/github-candidate-acceptance/sign-ed25519"]);
});

test("SCM merge HTTP boundary requires mTLS and exact workflow headers", async () => {
  const handler = createScmMergeHandler({ service: { async merge() { return { receiptId: mergeReceiptId, runId,
    candidateCommitSha, pullRequestNumber: 42, evidenceBundleId, acceptanceSignalId: "accepted-signal-001",
    mergeCommitSha: "1".repeat(40), defaultBranchHeadSha: "1".repeat(40), mainSourceDigest: "2".repeat(64), requiresFreshMainSnapshot: false }; },
    async probe() {} }, allowedSpiffeIds: new Set(["spiffe://deviludo.internal/service/scm-workflow"]),
    extractIdentity: () => ({ spiffeId: "spiffe://deviludo.internal/service/scm-workflow" }) });
  const request = command(); const response = await handler({ method: "POST", path: "/v1/merges", socket: {},
    rawBody: JSON.stringify(request), headers: { "content-type": "application/json", "idempotency-key": request.operationKey,
      "x-deviludo-request-digest": request.requestDigest } });
  assert.equal(response.status, 200); assert.equal(response.body.status, "COMPLETED"); assert.equal(response.body.mergeId, mergeReceiptId);
  const drift = await handler({ method: "POST", path: "/v1/merges", socket: {}, rawBody: JSON.stringify(request),
    headers: { "content-type": "application/json", "idempotency-key": request.operationKey, "x-deviludo-request-digest": "0".repeat(64) } });
  assert.equal(drift.status, 400);
  assert.deepEqual(await handler({ method: "GET", path: "/healthz", socket: {}, rawBody: "", headers: {} }), {
    status: 200,
    body: { schemaVersion: "deviludo.scm-merge-health.v1", status: "ok", service: "deviludo-scm-merge-broker" },
  });
});

test("PostgreSQL merge authority joins the delivered acceptance and non-invalidated evidence under RLS", async () => {
  const statements: string[] = [];
  const row = { acceptance_operation_key: acceptanceOperationKey, actor_id: "github-user-1", accepted_at: "2030-01-01T00:01:00.000Z",
    repository_binding_id: repositoryBindingId, installation_id: "12345", repository_id: 98_765, repository_node_id: "R_repo",
    owner_name: "deviludo", repository_name: "game", default_branch: "main", candidate_receipt_id: candidateReceiptId,
    candidate_receipt: candidate(), candidate_commit_sha: candidateCommitSha, candidate_source_digest: sourceDigest,
    pull_request_number: 42, evidence_bundle_id: evidenceBundleId, evidence_bundle_digest: evidenceDigest, spec_revision_id: specRevisionId };
  const client = { async query<Row extends Record<string, unknown>>(sql: string) { statements.push(sql);
    if (sql.includes("FROM deviludo.workflow_command_jobs job")) return { rowCount: 1, rows: [row as unknown as Row] };
    return { rowCount: 0, rows: [] as Row[] }; }, release() {} };
  const store = new PostgresScmMergeStore({ async connect() { return client; } } as PostgresWorkflowPool);
  const resolved = await store.resolve(command());
  assert.equal(resolved.acceptedBy, "github-user-1"); assert.equal(resolved.evidence.evidenceBundleDigest, evidenceDigest);
  const query = statements.find((sql) => sql.includes("workflow_command_jobs job")) ?? "";
  assert.match(query, /workflow_signal_outbox/); assert.match(query, /signal\.state = 'DELIVERED'/);
  assert.match(query, /evidence\.invalidated_at IS NULL/); assert.match(query, /job\.state = 'RUNNING'/);
  assert.ok(statements.some((sql) => sql.includes("set_config('app.tenant_id'")));
});

test("merge archive records workflow, acceptance and evidence bindings beside GitHub's receipt", async () => {
  const statements: string[] = [];
  const row = { id: mergeReceiptId, receipt: merged(), candidate_receipt_id: candidateReceiptId,
    acceptance_signal_id: command().acceptanceSignalId, evidence_bundle_id: evidenceBundleId };
  const client = { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) { statements.push(sql);
    if (sql.includes("FROM deviludo.github_merge_receipts")) return { rowCount: 1, rows: [row as unknown as Row] };
    if (sql.includes("INSERT INTO deviludo.github_merge_receipts")) { assert.equal(values?.[13], acceptanceOperationKey); return { rowCount: 1, rows: [] as Row[] }; }
    return { rowCount: 0, rows: [] as Row[] }; }, release() {} };
  const store = new PostgresScmMergeStore({ async connect() { return client; } } as PostgresWorkflowPool);
  assert.deepEqual(await store.persist({ request: command(), authority: authority(), receipt: merged() }), { receiptId: mergeReceiptId });
  const insert = statements.find((sql) => sql.includes("INSERT INTO deviludo.github_merge_receipts")) ?? "";
  assert.match(insert, /acceptance_operation_key/); assert.match(insert, /workflow_request_digest/);
  assert.equal(sha256Canonical(row.receipt), sha256Canonical(merged()));
});
