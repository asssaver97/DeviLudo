import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { MtlsScmCandidatePublisher } from "../../agent-execution-broker/src/scm-candidate-client";
import type { LockedAgentExecution } from "../../agent-execution-broker/src/contracts";
import type { PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { createCandidatePublicationRequest, validateCandidatePublicationReceipt } from "../src/candidate-publication-contracts";
import { createCandidatePublicationHandler } from "../src/candidate-publication-http";
import { AuthoritativeCandidatePublicationService } from "../src/candidate-publication-service";
import { contentSha256, signGitHubCandidateArtifact } from "../src/github-artifacts";
import type { GitHubCandidateReceipt, GitHubRepositoryBinding } from "../src/github-contracts";
import { PostgresScmOperationStore } from "../src/postgres-operation-store";
import { PostgresCandidatePublicationStore } from "../src/postgres-candidate-publication";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const receiptId = "55555555-5555-4555-8555-555555555555";
const specRevisionId = "66666666-6666-4666-8666-666666666666";
const baseCommitSha = "a".repeat(40);
const candidateCommitSha = "b".repeat(40);
const sourceDigest = "c".repeat(64);
const resolutionDigest = "d".repeat(64);
const key = generateKeyPairSync("ed25519").privateKey;

function artifact() {
  const content = Buffer.from("[application]\nrun/main_scene=\"res://main.tscn\"\n", "utf8");
  return signGitHubCandidateArtifact({ schemaVersion: "deviludo.github-candidate.v1", artifactId: "artifact-r1",
    tenantId, projectId, runId, attemptId, specRevisionId, expectedBaseCommitSha: baseCommitSha,
    candidateBranch: "deviludo/project/run-1", commitMessage: "agent: implement approved specification",
    sourceDigest, changes: Object.freeze([{ operation: "UPSERT" as const, path: "project.godot", mode: "100644" as const,
      contentBase64: content.toString("base64"), contentDigest: contentSha256(content), sizeBytes: content.byteLength }]),
    createdAt: "2030-01-01T00:00:00.000Z" }, key, "worker-attestation-v1");
}

function binding(): GitHubRepositoryBinding { return Object.freeze({ tenantId, projectId, installationId: "12345",
  repositoryId: 98_765, repositoryNodeId: "R_repo", owner: "deviludo", name: "game", defaultBranch: "main" }); }

function githubReceipt(): GitHubCandidateReceipt { return Object.freeze({ scmProxy: "github-app-proxy-v1", tenantId, projectId,
  installationId: "12345", repositoryId: 98_765, repositoryNodeId: "R_repo", artifactId: "artifact-r1",
  artifactDigest: artifact().payload.artifactDigest, baseBranch: "main", baseCommitSha,
  candidateBranch: "deviludo/project/run-1", candidateCommitSha, sourceDigest, changedFiles: Object.freeze(["project.godot"]),
  pullRequestNumber: 42, pullRequestNodeId: "PR_node", pullRequestUrl: "https://github.com/deviludo/game/pull/42",
  state: "DRAFT", createdAt: "2030-01-01T00:00:01.000Z" }); }

function request() { return createCandidatePublicationRequest({ tenantId, projectId, runId, attemptId, resolutionDigest, artifact: artifact() }); }

function lock(): LockedAgentExecution { return Object.freeze({ tenantId, projectId, runId, resolutionDigest,
  profileRevisionId: "profile-r1", installationId: "installation-r1", imageDigest: `sha256:${"e".repeat(64)}`,
  exactAgentVersion: "2.1.14", adapterVersion: "adapter-1.0.0", agent: "claude-code", providerRevisionId: "provider-r1",
  providerProtocol: "anthropic-messages", providerBaseUrl: "https://gateway.example.invalid/v1", credentialVersionId: "credential-v1",
  model: "gateway/claude-sonnet-4-6-20250514",
  modelRoles: { primaryModel: "gateway/claude-sonnet-4-6-20250514",
    planningModel: "gateway/claude-sonnet-4-6-20250514", smallFastModel: "gateway/claude-sonnet-4-6-20250514",
    subagentModel: "gateway/claude-sonnet-4-6-20250514" },
  authorizedModels: ["gateway/claude-sonnet-4-6-20250514"],
  authorizationNonce: "nonce-r1", authorizationExpiresAt: "2030-01-01T01:00:00.000Z",
  budget: { maxUsd: 10, maxTurns: 50, timeoutSeconds: 900 }, specRevisionId, specDigest: "d".repeat(64),
  testPlanRevisionId: "77777777-7777-4777-8777-777777777777", testPlanDigest: "e".repeat(64),
  targetMatrix: ["linux", "macos", "windows"] as const,
  repairContext: null,
  sourceBaselineReceiptId: "88888888-8888-4888-8888-888888888888", baseCommitSha, sourceDigest: "f".repeat(64) }); }

test("candidate publication contract binds the signed artifact to one Agent attempt", () => {
  const value = request();
  assert.equal(value.operationKey, `agent-candidate:${runId}:${attemptId}`);
  assert.equal(value.artifact.payload.expectedBaseCommitSha, baseCommitSha);
  assert.throws(() => createCandidatePublicationRequest({ tenantId, projectId, runId,
    attemptId: "99999999-9999-4999-8999-999999999999", resolutionDigest, artifact: artifact() }), /contract is invalid/);
});

test("authoritative service resolves repository authority, publishes a Draft PR and archives it", async () => {
  const calls: string[] = [];
  const service = new AuthoritativeCandidatePublicationService({
    async resolve(input) { calls.push(`authority:${input.runId}`); return { repositoryBindingId: receiptId, binding: binding(), specRevisionId }; },
    async probe() {},
  }, { async publishCandidate(input) { calls.push(`github:${input.binding.repositoryNodeId}`); assert.equal(input.artifact.payload.runId, runId);
      return githubReceipt(); } }, {
    async persist(input) { calls.push(`archive:${input.receipt.pullRequestNumber}`); return { receiptId }; }, async probe() {},
  }, () => new Date("2030-01-01T00:00:01.000Z"));
  const receipt = await service.publish(request());
  assert.equal(receipt.candidateCommitSha, candidateCommitSha); assert.equal(receipt.draftPullRequest, 42);
  assert.deepEqual(calls, [`authority:${runId}`, "github:R_repo", "archive:42"]);
});

test("PostgreSQL publication authority accepts only the exact predecessor candidate as a repair base", async () => {
  const predecessorRunId = "77777777-7777-4777-8777-777777777777";
  const baselineReceiptId = "88888888-8888-4888-8888-888888888888";
  const predecessorSourceDigest = "9".repeat(64);
  const configurationLock = {
    resolutionDigest,
    specRevisionId,
    sourceBaselineReceiptId: baselineReceiptId,
    commitSha: baseCommitSha,
    sourceDigest: predecessorSourceDigest,
    repairContext: {
      attempt: 1, reason: "E2E_FAILURE", fromRunConfigurationId: predecessorRunId,
      diagnosticId: null, agentDiagnostic: null, evidenceBundleId: "99999999-9999-4999-8999-999999999999",
      evidenceBundleDigest: "1".repeat(64), repairPromptId: `repair:${"1".repeat(64)}`,
      candidateCommitSha: baseCommitSha, draftPullRequest: 64, failedPlatforms: [],
    },
  };
  const sql: string[] = [];
  const client = {
    async query<Row extends Record<string, unknown>>(statement: string) {
      sql.push(statement);
      if (statement.includes("FROM deviludo.agent_runs run")) return { rowCount: 1, rows: [{
        tenant_id: tenantId, project_id: projectId, run_id: runId, run_state: "RUNNING",
        resolution_digest: resolutionDigest, configuration_lock: configurationLock,
        spec_revision_id: specRevisionId, source_baseline_receipt_id: baselineReceiptId,
        baseline_commit_sha: "0".repeat(40), baseline_source_digest: "2".repeat(64),
        predecessor_run_id: predecessorRunId, predecessor_commit_sha: baseCommitSha,
        predecessor_source_digest: predecessorSourceDigest, predecessor_pull_request: 64,
        repository_binding_id: receiptId, installation_id: "12345", repository_id: 98_765,
        repository_node_id: "R_repo", owner_name: "deviludo", repository_name: "game", default_branch: "main",
      } as unknown as Row] };
      return { rowCount: null, rows: [] as Row[] };
    },
    release() {},
  };
  const store = new PostgresCandidatePublicationStore({ async connect() { return client; } });
  const authority = await store.resolve(request());
  assert.equal(authority.repositoryBindingId, receiptId);
  assert.ok(sql.some((statement) => statement.includes("LEFT JOIN deviludo.github_candidate_receipts predecessor")));

  configurationLock.repairContext.fromRunConfigurationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await assert.rejects(store.resolve(request()), /publication authority is invalid/);
});

test("Agent Worker mTLS client accepts only the exact authoritative candidate receipt", async () => {
  const observed: unknown[] = [];
  const publisher = new MtlsScmCandidatePublisher({ endpoint: "https://scm.internal/v1/candidates",
    tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    http: async (_url, input) => {
      const submitted = JSON.parse(input.body ?? "null") as ReturnType<typeof request>; observed.push(submitted);
      return { statusCode: 200, payload: validateCandidatePublicationReceipt({ schemaVersion: "deviludo.scm-candidate-publication-receipt.v1",
        operationKey: submitted.operationKey, requestDigest: submitted.requestDigest, tenantId, projectId, runId, attemptId,
        resolutionDigest, artifactId: submitted.artifact.payload.artifactId, artifactDigest: submitted.artifact.payload.artifactDigest,
        baseCommitSha, candidateCommitSha, sourceDigest, draftPullRequest: 42, receiptId }, submitted) };
    },
  });
  const receipt = await publisher.publish({ lock: lock(), attemptId, artifact: artifact() });
  assert.equal(receipt.receiptId, receiptId); assert.equal(receipt.draftPullRequest, 42);
  assert.equal("githubToken" in (observed[0] as object), false); assert.equal("installationToken" in (observed[0] as object), false);
});

test("candidate HTTP ingress requires the exact mTLS workload and immutable headers", async () => {
  const service = new AuthoritativeCandidatePublicationService({ async resolve() { return { repositoryBindingId: receiptId,
      binding: binding(), specRevisionId }; }, async probe() {} },
    { async publishCandidate() { return githubReceipt(); } },
    { async persist() { return { receiptId }; }, async probe() {} }, () => new Date("2030-01-01T00:00:01.000Z"));
  const handler = createCandidatePublicationHandler({ service,
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/service/agent-execution-worker"]),
    healthIdentity: { version: "1.0.0", binaryDigest: "1".repeat(64) },
    extractIdentity: () => ({ spiffeId: "spiffe://deviludo.internal/service/agent-execution-worker" }) });
  const body = request();
  const response = await handler({ method: "POST", path: "/v1/candidates", socket: {}, rawBody: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-deviludo-tenant-id": tenantId,
      "idempotency-key": body.operationKey, "x-deviludo-request-digest": body.requestDigest } });
  assert.equal(response.status, 200); assert.equal(response.body.draftPullRequest, 42);
  const drift = await handler({ method: "POST", path: "/v1/candidates", socket: {}, rawBody: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-deviludo-tenant-id": projectId,
      "idempotency-key": body.operationKey, "x-deviludo-request-digest": body.requestDigest } });
  assert.equal(drift.status, 400);
});

test("PostgreSQL SCM operation store applies tenant RLS and fences one publication receipt", async () => {
  const sql: string[] = []; const operationKey = `github:publish:${tenantId}:${projectId}:${request().operationKey}`;
  let row = { operation_key: operationKey, tenant_id: tenantId, project_id: projectId, operation: "PUBLISH_CANDIDATE",
    request_digest: request().requestDigest, claim_token: "77777777-7777-4777-8777-777777777777",
    claim_expires_at: "2030-01-01T00:05:00.000Z", response: null as unknown | null };
  const client = { async query<Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]) {
    sql.push(statement.trim());
    if (statement.includes("FROM deviludo.scm_operation_claims")) return { rowCount: 1, rows: [{ ...row } as unknown as Row] };
    if (statement.includes("SET response")) { row = { ...row, response: values?.[3] ? JSON.parse(String(values[3])) : null }; return { rowCount: 1, rows: [] as Row[] }; }
    return { rowCount: statement.startsWith("INSERT") || statement.startsWith("UPDATE") ? 1 : 0, rows: [] as Row[] };
  }, release() {} };
  const pool: PostgresWorkflowPool = { async connect() { return client; } };
  const store = new PostgresScmOperationStore(pool);
  const acquired = await store.acquire({ key: operationKey, requestDigest: request().requestDigest,
    claimToken: row.claim_token, claimedAt: "2030-01-01T00:00:00.000Z", claimExpiresAt: row.claim_expires_at });
  assert.equal(acquired.status, "ACQUIRED");
  await store.complete({ key: operationKey, requestDigest: request().requestDigest,
    claimToken: row.claim_token, response: githubReceipt() });
  assert.deepEqual((await store.inspect<GitHubCandidateReceipt>(operationKey))?.response, githubReceipt());
  assert.ok(sql.some((statement) => statement.includes("set_config('app.tenant_id'")));
  assert.equal(sql.filter((statement) => statement === "COMMIT").length, 3);
});
