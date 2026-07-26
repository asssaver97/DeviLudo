import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresAgentMicrovmCredentialAuthority } from "../src/guest-credential-authority-postgres";
import { parseAgentMicrovmCredentialImageRequest } from "../src/guest-credential-contracts";
import { LockedExt4GuestCredentialImageBuilder } from "../src/guest-credential-image";
import { createGuestCredentialIssuerHandler } from "../src/guest-credential-ingress";
import { AgentMicrovmCredentialIssuerService } from "../src/guest-credential-service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const workerSpiffeId = "spiffe://deviludo.internal/agent-execution/native-worker";
const identity = Object.freeze({ spiffeId: workerSpiffeId, certificateFingerprint: "d".repeat(64),
  certificateSerial: "01", certificateNotAfter: "2030-01-02T00:00:00.000Z" });

function request() {
  return Object.freeze({
    schemaVersion: "deviludo.agent-microvm-credential-image-request.v1" as const,
    tenantId, projectId, runId, attemptId,
    profileRevisionId: "profile-revision-1", installationId: "installation-1",
    agent: "claude-code" as const, exactAgentVersion: "2.1.201", adapterVersion: "1.3.0",
    workerImageDigest: `sha256:${"a".repeat(64)}` as const,
    providerRevisionId: "provider-revision-1", credentialVersionId: "credential-version-1",
    attestationKeyId: "microvm-attestation-v1", nativeRequestDigest: "b".repeat(64),
    expiresAt: "2030-01-01T00:15:00.000Z",
  });
}

test("credential image contract is exact and binds the complete native request digest", () => {
  assert.deepEqual(parseAgentMicrovmCredentialImageRequest(request()), request());
  assert.throws(() => parseAgentMicrovmCredentialImageRequest({ ...request(), secretRef: "secret://leak" }), /request is invalid/);
  assert.throws(() => parseAgentMicrovmCredentialImageRequest({ ...request(), nativeRequestDigest: "latest" }), /request is invalid/);
  assert.throws(() => parseAgentMicrovmCredentialImageRequest({ ...request(), workerImageDigest: "sha256:latest" }), /request is invalid/);
});

test("issuer authenticates headers before authority work and returns only an expiring binary image", async () => {
  const image = Buffer.alloc(128 * 1024); image.writeUInt16LE(0xef53, 1080);
  const digest = createHash("sha256").update(image).digest("hex");
  const calls: string[] = [];
  const service = new AgentMicrovmCredentialIssuerService({
    attestationKeyId: "microvm-attestation-v1", now: () => new Date("2030-01-01T00:00:00.000Z"),
    authority: { async authorize() { calls.push("authorize"); }, async record(input) {
      calls.push("record"); assert.equal(input.requesterSpiffeId, workerSpiffeId); assert.equal(input.imageDigest, digest);
    }, async probe() { calls.push("authority-probe"); } },
    builder: { async build() { calls.push("build"); return { image: Buffer.from(image), digest, sizeBytes: image.byteLength }; },
      async probe() { calls.push("builder-probe"); } },
  });
  const handler = createGuestCredentialIssuerHandler({ service, allowedSpiffeIds: new Set([workerSpiffeId]),
    extractIdentity: () => identity });
  const valid = await handler({ method: "POST", path: "/v1/agent-microvm-credentials:issue",
    headers: { "content-type": "application/json", "x-deviludo-run-id": runId,
      "x-deviludo-attempt-id": attemptId }, socket: {}, rawBody: JSON.stringify(request()) });
  assert.equal(valid.status, 200); assert.ok(Buffer.isBuffer(valid.body));
  assert.deepEqual(valid.headers, { "x-deviludo-content-sha256": digest,
    "x-deviludo-run-id": runId, "x-deviludo-attempt-id": attemptId,
    "x-deviludo-expires-at": request().expiresAt });
  assert.deepEqual(calls, ["authorize", "build", "record"]);

  calls.length = 0;
  const mismatched = await handler({ method: "POST", path: "/v1/agent-microvm-credentials:issue",
    headers: { "content-type": "application/json", "x-deviludo-run-id": runId,
      "x-deviludo-attempt-id": runId }, socket: {}, rawBody: JSON.stringify(request()) });
  assert.equal(mismatched.status, 400); assert.deepEqual(calls, []);
  const forbidden = await createGuestCredentialIssuerHandler({ service, allowedSpiffeIds: new Set([workerSpiffeId]),
    extractIdentity: () => ({ ...identity, spiffeId: "spiffe://deviludo.internal/other" }) })({ method: "GET", path: "/healthz",
    headers: {}, socket: {}, rawBody: "" });
  assert.equal(forbidden.status, 403); assert.deepEqual(calls, []);
});

test("PostgreSQL authority revalidates the active fenced attempt and appends digest-only audit", async () => {
  const sql: string[] = []; const values: (readonly unknown[])[] = [];
  const authorityRow = { operation_state: "RUNNING", attempt_id: attemptId, run_state: "RUNNING",
    configuration_lock: { profileRevisionId: request().profileRevisionId, installationId: request().installationId,
      agent: request().agent, exactAgentVersion: request().exactAgentVersion, adapterVersion: request().adapterVersion,
      imageDigest: request().workerImageDigest, providerRevisionId: request().providerRevisionId,
      credentialVersionId: request().credentialVersionId }, authorization_state: "ACTIVE",
    authorization_expires_at: request().expiresAt, failover_to_profile_revision_id: null,
    failover_to_provider_revision_id: null, failover_to_credential_version_id: null,
    failover_authorization_expires_at: null, provider_state: "ACTIVE" };
  const client: PostgresWorkflowClient = { async query<Row extends Record<string, unknown>>(text: string, bound: readonly unknown[] = []) {
    sql.push(text); values.push(bound);
    if (text.includes("FROM deviludo.agent_execution_operations")) return { rowCount: 1, rows: [authorityRow] } as never;
    if (text.includes("INSERT INTO deviludo.agent_microvm_credential_issuances")) return { rowCount: 1, rows: [] } as never;
    return { rowCount: null, rows: [] as readonly Row[] }; }, release() {} };
  const authority = new PostgresAgentMicrovmCredentialAuthority({ async connect() { return client; } });
  await authority.authorize(request(), "2030-01-01T00:00:00.000Z");
  await authority.record({ request: request(), requesterSpiffeId: workerSpiffeId,
    imageDigest: "c".repeat(64), imageSizeBytes: 8 * 1024 * 1024, issuedAt: "2030-01-01T00:00:01.000Z" });
  assert.equal(sql.filter((statement) => statement === "BEGIN").length, 2);
  assert.equal(sql.filter((statement) => statement.includes("set_config('app.tenant_id'")).length, 2);
  assert.equal(sql.filter((statement) => statement.includes("FROM deviludo.agent_execution_operations")).length, 2);
  const insertIndex = sql.findIndex((statement) => statement.includes("INSERT INTO deviludo.agent_microvm_credential_issuances"));
  assert.ok(insertIndex > 0); assert.equal(values[insertIndex]?.includes("c".repeat(64)), true);
  assert.doesNotMatch(JSON.stringify(values), /BEGIN (?:PRIVATE KEY|CERTIFICATE)|secret:\/\//);

  const driftedClient: PostgresWorkflowClient = { async query<Row extends Record<string, unknown>>(text: string) {
    return text.includes("FROM deviludo.agent_execution_operations")
      ? { rowCount: 1, rows: [{ ...authorityRow, attempt_id: runId }] } as never
      : { rowCount: null, rows: [] as readonly Row[] }; }, release() {} };
  const drifted = new PostgresAgentMicrovmCredentialAuthority({ async connect() { return driftedClient; } });
  await assert.rejects(drifted.authorize(request(), "2030-01-01T00:00:00.000Z"), /authority is invalid/);
});

test("locked image builder uses fixed mke2fs arguments and embeds only read-only guest bootstrap files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-credential-issuer-"))); await chmod(root, 0o700);
  const executable = join(root, "mke2fs"); const executableBytes = Buffer.from("pinned-mke2fs");
  await writeFile(executable, executableBytes, { mode: 0o500 });
  const observed: string[][] = []; let runtime: Record<string, string> | undefined;
  const materialBuffer = () => Buffer.alloc(64, 7);
  const builder = new LockedExt4GuestCredentialImageBuilder({ workRoot: root, mke2fsExecutable: executable,
    mke2fsDigest: createHash("sha256").update(executableBytes).digest("hex"), material: {
      attestationPrivateKey: materialBuffer(), relayServerKey: materialBuffer(), relayServerCertificate: materialBuffer(),
      gatewayClientKey: materialBuffer(), gatewayClientCertificate: materialBuffer(), gatewayCa: materialBuffer(),
      ephemeralSecretClientKey: materialBuffer(), ephemeralSecretClientCertificate: materialBuffer(),
      ephemeralSecretCa: materialBuffer(), relayOrigin: "https://127.0.0.1:8443/",
      ephemeralSecretBrokerUrl: "https://ephemeral-secrets.internal/",
    }, process: async (_binary, args) => { observed.push([...args]); if (args[0] === "-V") return { exitCode: 0, stdout: "", stderr: "mke2fs 1.47" };
      const staging = args[args.indexOf("-d") + 1]!; const imagePath = args.at(-2)!;
      runtime = JSON.parse(await readFile(join(staging, "guest-runtime.json"), "utf8")) as Record<string, string>;
      assert.equal((await readFile(join(staging, "attestation-private.pem"))).byteLength, 64);
      const image = await open(imagePath, "r+"); try { const magic = Buffer.alloc(2); magic.writeUInt16LE(0xef53); await image.write(magic, 0, 2, 1080); }
      finally { await image.close(); } return { exitCode: 0, stdout: "", stderr: "" }; } });
  try {
    const result = await builder.build(request()); await builder.probe();
    assert.equal(result.sizeBytes, 8 * 1024 * 1024); assert.equal(result.image.readUInt16LE(1080), 0xef53);
    assert.equal(runtime?.DEVILUDO_MICROVM_GUEST_REQUEST_DIGEST, request().nativeRequestDigest);
    assert.equal(runtime?.DEVILUDO_MICROVM_GUEST_RELAY_ORIGIN, "https://127.0.0.1:8443/");
    assert.deepEqual(observed[0]?.slice(0, 14), ["-q", "-t", "ext4", "-F", "-b", "4096", "-I", "256",
      "-m", "0", "-L", "DEVILUDO_CRED", "-U", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
    assert.ok(observed[0]?.includes("^has_journal,^orphan_file"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
