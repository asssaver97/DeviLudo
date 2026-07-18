import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import { contentSha256, signGitHubCandidateArtifact } from "../../scm-proxy/src/github-artifacts";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { IsolatedAgentExecutionRequest } from "../src/contracts";
import { MtlsEphemeralRunTokenSecretResolver, MtlsEphemeralRunTokenSecretStore } from "../src/ephemeral-secret-client";
import { LockedNativeMicrovmAgentExecutor } from "../src/native-microvm-executor";
import { PostgresAgentDevelopmentWorkPackage } from "../src/postgres-work-package";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const specRevisionId = "55555555-5555-4555-8555-555555555555";
const testPlanRevisionId = "66666666-6666-4666-8666-666666666666";
const baselineId = "77777777-7777-4777-8777-777777777777";
const baselineSourceDigest = "8".repeat(64);
const baseCommitSha = "9".repeat(40);
const specPayload = Object.freeze({ schemaVersion: "deviludo.game-spec.v1", conversationId: "conversation-r1", revision: 2,
  spec: Object.freeze({ title: "Signal Orchard", elevatorPitch: "A compact deterministic strategy game.", genre: "Strategy",
    godotVersion: "4.6.2.stable", targetPlatforms: Object.freeze(["linux", "windows"]), features: Object.freeze(["Core loop"]),
    acceptanceCriteria: Object.freeze([{ id: "core-loop", description: "A full match can be completed.", required: true }]) }) });
const planPayload = Object.freeze({ schemaVersion: "deviludo.test-plan.v1", conversationId: "conversation-r1", revision: 2,
  testPlan: Object.freeze({ version: "godot-testkit-1.0.0", scenarios: Object.freeze(["Complete one match"]), minimumFps: 60, maxCrashCount: 0 }) });

function request(): IsolatedAgentExecutionRequest {
  return Object.freeze({ tenantId, projectId, runId, attemptId, resolutionDigest: "a".repeat(64),
    profileRevisionId: "profile-r1", installationId: "installation-r1", imageDigest: `sha256:${"b".repeat(64)}`,
    exactAgentVersion: "2.1.14", adapterVersion: "adapter-1.0.0", agent: "claude-code",
    providerRevisionId: "provider-r1", providerProtocol: "anthropic-messages",
    providerBaseUrl: "https://third-party.example.invalid/v1", credentialVersionId: "credential-v1",
    model: "gateway/claude-sonnet-4-6-20250514",
    modelRoles: { primaryModel: "gateway/claude-sonnet-4-6-20250514",
      planningModel: "gateway/claude-sonnet-4-6-20250514", smallFastModel: "gateway/claude-sonnet-4-6-20250514",
      subagentModel: "gateway/claude-sonnet-4-6-20250514" },
    authorizedModels: ["gateway/claude-sonnet-4-6-20250514"],
    authorizationNonce: "nonce-r1", authorizationExpiresAt: "2030-01-01T00:15:00.000Z",
    budget: { maxUsd: 10, maxTurns: 50, timeoutSeconds: 600 }, specRevisionId,
    specDigest: sha256Canonical(specPayload), testPlanRevisionId, testPlanDigest: sha256Canonical(planPayload),
    targetMatrix: ["linux", "windows"] as const, sourceBaselineReceiptId: baselineId,
    baseCommitSha, sourceDigest: baselineSourceDigest,
    inferenceTokenSecretRef: `secret://agent-runs/${runId}/${attemptId}`,
    inferenceTokenExpiresAt: "2030-01-01T00:15:00.000Z" });
}

test("PostgreSQL work package re-resolves the approved spec pair under tenant RLS", async () => {
  const sql: string[] = [];
  const client = fakeClient(async (statement) => {
    sql.push(statement);
    if (statement.includes("FROM deviludo.immutable_revisions spec")) return rows([{ spec_revision_id: specRevisionId,
      spec_state: "APPROVED", spec_payload: specPayload, spec_digest: sha256Canonical(specPayload),
      test_plan_revision_id: testPlanRevisionId, test_plan_state: "FROZEN", test_plan_payload: planPayload,
      test_plan_digest: sha256Canonical(planPayload), bound_test_plan_digest: sha256Canonical(planPayload),
      bound_target_matrix: ["linux", "windows"] }]);
    return rows([]);
  });
  const work = await new PostgresAgentDevelopmentWorkPackage(pool(client)).resolve(request());
  assert.match(work.promptDigest, /^[a-f0-9]{64}$/);
  assert.match(work.prompt, /Signal Orchard/);
  assert.ok(sql.some((statement) => statement.includes("set_config('app.tenant_id'")));
  assert.equal(sql.at(-1), "COMMIT");
});

test("mTLS ephemeral secret store deposits binary DLRT bytes and returns only an opaque SecretRef", async () => {
  const calls: Array<{ path: string; method: string; body: Buffer | string | undefined }> = [];
  const secretRef = `secret://agent-runs/${runId}/${attemptId}`;
  const store = new MtlsEphemeralRunTokenSecretStore({ endpoint: "https://vault-broker.internal/",
    tls: { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    http: async (url, input) => { calls.push({ path: url.pathname, method: input.method, body: input.body });
      if (url.pathname === "/healthz") return { statusCode: 200, payload: { status: "ok", service: "deviludo-ephemeral-secret-broker" } };
      if (url.pathname.endsWith(":revoke")) return { statusCode: 204, payload: {} };
      return { statusCode: 201, payload: { schemaVersion: "deviludo.ephemeral-run-token-receipt.v1",
        runId, attemptId, expiresAt: "2030-01-01T00:15:00.000Z", secretRef } }; } });
  const token = Buffer.from("signed-internal-run-token-material-that-is-long-enough");
  assert.deepEqual(await store.put({ runId, attemptId, value: token, expiresAt: "2030-01-01T00:15:00.000Z" }), { secretRef });
  await store.revoke(secretRef); await store.probe();
  assert.ok(Buffer.isBuffer(calls[0]?.body)); assert.equal((calls[0]?.body as Buffer).equals(token), true);
  assert.equal(calls[1]?.body, JSON.stringify({ schemaVersion: "deviludo.ephemeral-run-token-revoke.v1", secretRef }));
  assert.equal(calls[2]?.path, "/healthz");
});

test("microVM guest resolves only its exact opaque DLRT reference over mTLS", async () => {
  const token = Buffer.from("signed-internal-run-token-material-that-is-long-enough");
  const observed: Array<{ path: string; body: Buffer | string | undefined }> = [];
  const resolver = new MtlsEphemeralRunTokenSecretResolver({ endpoint: "https://vault-broker.internal/",
    tls: { key: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), ca: Buffer.alloc(32, 3) },
    http: async (url, input) => { observed.push({ path: url.pathname, body: input.body });
      if (url.pathname === "/healthz") return { statusCode: 200, payload: { status: "ok", service: "deviludo-ephemeral-secret-broker" } };
      return { statusCode: 200, payload: token }; } });
  assert.equal(await resolver.resolve(`secret://agent-runs/${runId}/${attemptId}`,
    { runId, attemptId, environmentVariable: "ANTHROPIC_API_KEY" }), token.toString("utf8"));
  await resolver.probe();
  const requestBody = JSON.parse(String(observed[0]?.body)) as Record<string, unknown>;
  assert.equal(requestBody.runId, runId); assert.equal(requestBody.attemptId, attemptId);
  assert.equal("token" in requestBody, false); assert.equal(observed[0]?.path, "/v1/ephemeral-run-tokens:resolve");
  await assert.rejects(resolver.resolve(`secret://agent-runs/${runId}/${attemptId}`,
    { runId, attemptId: "not-an-attempt", environmentVariable: "ANTHROPIC_API_KEY" }), /contract is invalid/);
});

test("locked native executor provisions the baseline and accepts only an attested microVM candidate", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-native-agent-")));
  const executable = join(root, "microvm-launcher"); const config = join(root, "launcher.json"); const workRoot = join(root, "work");
  await Promise.all([writeFile(executable, "native-agent-v1", { mode: 0o700 }), writeFile(config, "{}", { mode: 0o400 }), mkdir(workRoot, { mode: 0o700 })]);
  const keys = generateKeyPairSync("ed25519"); const observedRequests: Record<string, unknown>[] = []; let sourceCalls = 0;
  const executor = new LockedNativeMicrovmAgentExecutor({ executable, executableDigest: digest("native-agent-v1"),
    configFile: config, configDigest: digest("{}"), workRoot, inferenceGatewayUrl: "https://inference.internal/",
    timeoutMs: 15 * 60_000, attestationKeyId: "microvm-attestation-v1", attestationPublicKey: keys.publicKey,
    now: () => new Date("2030-01-01T00:00:00.000Z"), packages: { async probe() {}, async resolve(lock) { return {
      prompt: "Implement the approved game", promptDigest: "c".repeat(64), specDigest: lock.specDigest, testPlanDigest: lock.testPlanDigest }; } },
    sources: { async probe() {}, async materialize(input) { sourceCalls += 1; await mkdir(input.destinationPath, { mode: 0o700 });
      await writeFile(join(input.destinationPath, "project.godot"), "[application]\n"); return { sourceDigest: input.sourceDigest }; } },
    process: async (_executable, args) => {
      if (args[0] === "probe") return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: "deviludo.native-agent-microvm-probe.v1", status: "READY", configDigest: digest("{}") }), stderr: "" };
      const requestFile = args[args.indexOf("--request-file") + 1]!; const responseFile = args[args.indexOf("--response-file") + 1]!;
      observedRequests.push(JSON.parse(await readFile(requestFile, "utf8")) as Record<string, unknown>);
      const content = Buffer.from("extends Node\n");
      const artifact = signGitHubCandidateArtifact({ schemaVersion: "deviludo.github-candidate.v1", artifactId: "artifact-r1",
        tenantId, projectId, runId, attemptId, specRevisionId, expectedBaseCommitSha: baseCommitSha,
        candidateBranch: "deviludo/project/attempt", commitMessage: "agent: implement approved spec", sourceDigest: "d".repeat(64),
        changes: [{ operation: "UPSERT", path: "main.gd", mode: "100644", contentBase64: content.toString("base64"),
          contentDigest: contentSha256(content), sizeBytes: content.byteLength }], createdAt: "2030-01-01T00:05:00.000Z" },
      keys.privateKey, "microvm-attestation-v1");
      const locked = request();
      await writeFile(responseFile, JSON.stringify({ status: "COMPLETED", runId, attemptId,
        resolutionDigest: locked.resolutionDigest, profileRevisionId: locked.profileRevisionId,
        installationId: locked.installationId, imageDigest: locked.imageDigest, adapterVersion: locked.adapterVersion,
        providerRevisionId: locked.providerRevisionId, credentialVersionId: locked.credentialVersionId,
        model: locked.model, executionReceiptId: "microvm-receipt-r1", candidateArtifact: artifact, diagnosticId: null }));
      return { exitCode: 0, stdout: "", stderr: "" };
    } });
  await executor.probe();
  let heartbeats = 0; const result = await executor.execute(request(), { heartbeat: async () => { heartbeats += 1; } });
  assert.equal(result.status, "COMPLETED"); assert.equal(sourceCalls, 1); assert.equal(heartbeats, 3);
  const observedRequest = observedRequests[0]; assert.ok(observedRequest);
  assert.equal(observedRequest.inferenceGatewayUrl, "https://inference.internal/");
  assert.deepEqual(observedRequest.modelRoles, request().modelRoles);
  assert.equal("providerBaseUrl" in observedRequest, false);
  assert.equal("apiKey" in observedRequest, false);
});

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function rows<T extends Record<string, unknown>>(values: readonly T[]) { return { rows: values, rowCount: values.length }; }
function fakeClient(query: (statement: string, values: readonly unknown[]) => Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number }>): PostgresWorkflowClient {
  return { query: query as PostgresWorkflowClient["query"], release() {} };
}
function pool(client: PostgresWorkflowClient): PostgresWorkflowPool { return { async connect() { return client; } }; }
