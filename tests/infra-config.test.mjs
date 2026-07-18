import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("local integration PostgreSQL applies every migration in order", () => {
  const compose = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  const offsets = Array.from({ length: 15 }, (_, index) => {
    const prefix = String(index + 1).padStart(3, "0");
    const marker = `./postgres/${prefix}_`;
    const offset = compose.indexOf(marker);
    assert.notEqual(offset, -1, `missing PostgreSQL migration ${prefix}`);
    return offset;
  });
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
});

test("Runner ingress persists replayable signed jobs and immutable lease/event bindings", () => {
  const migration = readFileSync(new URL("../infra/postgres/015_runner_ingress_transactions.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/runner-control/src/postgres-ingress.ts", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN job jsonb/);
  assert.match(migration, /runner identity and capabilities are immutable/);
  assert.match(migration, /platform lease binding and signed job are immutable/);
  assert.match(migration, /platform_runner_events_append_only/);
  assert.match(adapter, /FOR UPDATE OF attempt SKIP LOCKED/);
  assert.match(adapter, /COALESCE\(MAX\(fencing_token\), 0\) \+ 1/);
  assert.match(adapter, /Runner is not assigned to this tenant/);
  assert.match(adapter, /signCanonical/);
  assert.match(adapter, /INSERT INTO deviludo\.platform_runner_events/);
  assert.match(adapter, /INSERT INTO deviludo\.evidence_bundles/);
  assert.match(adapter, /FOR UPDATE/);
});

test("physical Runner HTTP ingress is an isolated fail-closed mTLS boundary", () => {
  const ingress = readFileSync(new URL("../services/runner-control/src/ingress-http.ts", import.meta.url), "utf8");
  assert.match(ingress, /identityFromTlsSocket/);
  assert.match(ingress, /requestCert: true/);
  assert.match(ingress, /rejectUnauthorized: true/);
  assert.match(ingress, /minVersion: "TLSv1\.3"/);
  assert.match(ingress, /RUNNER_REQUEST_TOO_LARGE/);
  assert.match(ingress, /RUNNER_REQUEST_REJECTED/);
  assert.doesNotMatch(ingress, /x-runner-id/);
});

test("physical Runner host composes signed fleet authorization and mTLS evidence archival", () => {
  const host = readFileSync(new URL("../services/runner-control/src/run-ingress-service.ts", import.meta.url), "utf8");
  const fleet = readFileSync(new URL("../services/runner-control/src/fleet-manifest.ts", import.meta.url), "utf8");
  const archive = readFileSync(new URL("../services/runner-control/src/evidence-archive.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["start:runner-ingress"], "node --import tsx services/runner-control/src/run-ingress-service.ts");
  assert.match(host, /await readiness\(\);\s+await listen/);
  assert.match(host, /DEVILUDO_RUNNER_JOB_SIGNING_KEY_FILE/);
  assert.match(fleet, /MAX_VALIDITY_MS = 15 \* 60_000/);
  assert.match(fleet, /certificateFingerprint === identity\.certificateFingerprint/);
  assert.match(fleet, /entry\.tenantIds\.includes/);
  assert.match(archive, /minVersion: "TLSv1\.3"/);
  assert.match(archive, /"idempotency-key": input\.bundle\.bundleDigest/);
  assert.match(archive, /body\.bundleDigest !== expected\.bundle\.bundleDigest/);
});

test("physical Runner daemon locks local recovery, TestKit execution and machine identity", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const journal = readFileSync(new URL("../services/runner-control/src/physical-runner-journal.ts", import.meta.url), "utf8");
  const testkit = readFileSync(new URL("../services/runner-control/src/testkit-executor.ts", import.meta.url), "utf8");
  const artifacts = readFileSync(new URL("../services/runner-control/src/testkit-artifact-client.ts", import.meta.url), "utf8");
  const daemon = readFileSync(new URL("../services/runner-control/src/run-physical-runner.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:physical-runner"], "node --import tsx services/runner-control/src/run-physical-runner.ts");
  assert.match(journal, /createHmac\("sha256"/);
  assert.match(journal, /timingSafeEqual/);
  assert.match(journal, /await rename\(temporary, path\)/);
  assert.match(testkit, /observedTestKit !== this\.#testKitDigest/);
  assert.match(testkit, /shell: false/);
  assert.match(testkit, /"--request-file", requestPath/);
  assert.match(testkit, /signedJob/);
  assert.match(artifacts, /changed during upload/);
  assert.match(artifacts, /x-amz-checksum-sha256/);
  assert.match(artifacts, /allowedTransferOrigins/);
  assert.match(daemon, /config\.capabilities\.platform !== expectedPlatform/);
  assert.match(daemon, /Promise\.all\(\[service\.ingress\.probe\(\), service\.executor\.probe\(\)\]\)/);
});

test("Godot TestKit is a fixed signed-job CLI and part of the full service gate", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const cli = readFileSync(new URL("../services/godot-testkit/src/run-cli.ts", import.meta.url), "utf8");
  const controller = readFileSync(new URL("../services/godot-testkit/src/controller.ts", import.meta.url), "utf8");
  const driver = readFileSync(new URL("../services/godot-testkit/src/godot-driver.ts", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../services/godot-testkit/README.md", import.meta.url), "utf8");
  assert.match(packageJson.scripts["test:services"], /npm run test:godot-testkit/);
  assert.equal(packageJson.scripts["start:godot-testkit"], "node --import tsx services/godot-testkit/src/run-cli.ts");
  assert.match(cli, /parseGodotTestKitRunRequest/);
  assert.match(cli, /basename\(requestPath\) !== "request\.json"/);
  assert.match(controller, /maximumExecutionSeconds \+ 300/);
  assert.match(controller, /exportedFiles\.length > 0/);
  assert.match(driver, /shell: false/);
  assert.match(driver, /--write-movie/);
  assert.doesNotMatch(driver, /dangerously|--yolo/);
  assert.match(readme, /not a production Runner artifact/);
  assert.match(readme, /signed the native artifacts for all selected Runner systems/);
});

test("artifact preparation publishes canonical source and plan objects before the append-only lock", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const preparer = readFileSync(new URL("../services/artifact-preparer/src/preparer.ts", import.meta.url), "utf8");
  const postgres = readFileSync(new URL("../services/artifact-preparer/src/postgres-lock-store.ts", import.meta.url), "utf8");
  const builder = readFileSync(new URL("../services/godot-testkit/src/source-bundle-builder.ts", import.meta.url), "utf8");
  assert.match(packageJson.scripts["test:services"], /npm run test:artifact-preparer/);
  assert.match(preparer, /Promise\.all\(\[\s*this\.#objects\.publishFile/);
  assert.match(preparer, /exactObjectReceipt\(sourceReceipt/);
  assert.match(preparer, /this\.#locks\.persist/);
  assert.ok(preparer.indexOf("this.#locks.persist") > preparer.indexOf("exactObjectReceipt(sourceReceipt"));
  assert.match(postgres, /set_config\('app\.tenant_id'/);
  assert.match(postgres, /ON CONFLICT \(tenant_id, lock_key\) DO NOTHING/);
  assert.match(builder, /constants\.O_NOFOLLOW/);
  assert.match(builder, /createZstdCompress/);
  assert.match(builder, /source snapshot mutation/);
});

test("evidence archive is a separate mTLS and immutable S3 trust boundary", () => {
  const ingress = readFileSync(new URL("../services/evidence-archive/src/ingress-http.ts", import.meta.url), "utf8");
  const archive = readFileSync(new URL("../services/evidence-archive/src/archive.ts", import.meta.url), "utf8");
  const s3 = readFileSync(new URL("../services/evidence-archive/src/s3-store.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/evidence-archive/src/run-service.ts", import.meta.url), "utf8");
  const artifacts = readFileSync(new URL("../services/evidence-archive/src/runner-artifacts.ts", import.meta.url), "utf8");
  assert.match(ingress, /requestCert: true/);
  assert.match(ingress, /rejectUnauthorized: true/);
  assert.match(ingress, /allowedSpiffeIds\.has/);
  assert.match(archive, /sha256Canonical\(core\)/);
  assert.match(archive, /repair:\$\{request\.bundleDigest\}/);
  assert.match(s3, /"if-none-match": "\*"/);
  assert.match(s3, /existing\.body/);
  assert.match(s3, /x-amz-checksum-sha256/);
  assert.match(ingress, /\/v1\/runner-artifact-grants/);
  assert.match(ingress, /\/v1\/runner-artifact-commits/);
  assert.match(artifacts, /verifyRunnerJob/);
  assert.match(artifacts, /MAX_GRANT_SECONDS = 300/);
  assert.match(artifacts, /verifyEvidenceArtifacts/);
  assert.match(service, /filesystem backend is forbidden in production/);
});

test("physical Runner attempts require an append-only tenant execution lock", () => {
  const migration = readFileSync(new URL("../infra/postgres/014_runner_execution_locks.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/runner-control/src/postgres-workflow.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.runner_execution_locks/);
  assert.match(migration, /UNIQUE \(tenant_id, lock_key\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /runner_execution_locks_append_only/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, project_id, run_id, execution_lock_id\)/);
  assert.match(migration, /workflow_operation_key IS NULL OR execution_lock_id IS NOT NULL/);
  assert.match(adapter, /FROM deviludo\.runner_execution_locks/);
  assert.match(adapter, /RUNNER_EXECUTION_LOCK_BINDING_CONFLICT/);
  assert.match(adapter, /executionLockDigest/);
});

test("Runner workflow attempts are immutable, tenant-scoped and content-bound", () => {
  const migration = readFileSync(new URL("../infra/postgres/013_runner_workflow_attempts.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/runner-control/src/postgres-workflow.ts", import.meta.url), "utf8");
  assert.match(migration, /UNIQUE \(tenant_id, workflow_operation_key\)/);
  assert.match(migration, /main_source_digest/);
  assert.match(migration, /e2e_attempt_workflow_binding_immutable/);
  assert.match(migration, /evidence_bundle_immutable/);
  assert.match(adapter, /set_config\('app\.tenant_id'/);
  assert.match(adapter, /ON CONFLICT \(tenant_id, workflow_operation_key\) DO NOTHING/);
  assert.match(adapter, /createEvidenceBundle/);
});

test("workflow inbox idempotency is tenant-scoped in schema and adapter", () => {
  const adapter = readFileSync(new URL("../services/temporal/src/postgres-inbox.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../infra/postgres/009_workflow_inbox_tenant_key.sql", import.meta.url), "utf8");
  assert.match(migration, /PRIMARY KEY \(tenant_id, idempotency_key\)/);
  assert.match(adapter, /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/);
  assert.match(adapter, /WHERE tenant_id = \$2::uuid\s+AND idempotency_key = \$1/g);
  assert.doesNotMatch(adapter, /ON CONFLICT \(idempotency_key\)/);
});

test("production admin idempotency has a pinned PostgreSQL driver and durable claim schema", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/010_admin_idempotency.sql", import.meta.url), "utf8");
  assert.equal(packageJson.dependencies.pg, "8.22.0");
  assert.match(migration, /identity_digest text PRIMARY KEY/);
  assert.match(migration, /state IN \('AVAILABLE', 'CLAIMED', 'COMPLETED'\)/);
  assert.match(migration, /pg_column_size\(response_payload\) <= 1048576/);
});

test("production Agent administration has a versioned catalog and append-only audit schema", () => {
  const migration = readFileSync(new URL("../infra/postgres/011_admin_catalog.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.admin_catalog_state/);
  assert.match(migration, /NEW\.revision <> OLD\.revision \+ 1/);
  assert.match(migration, /CREATE TABLE deviludo\.admin_audit_records/);
  assert.match(migration, /admin_audit_append_only/);
});

test("control-plane wait persistence uses the shared tenant RLS setting", () => {
  const adapter = readFileSync(new URL("../services/control-plane/src/workflow-action-postgres.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../infra/postgres/008_workflow_control_actions.sql", import.meta.url), "utf8");
  assert.match(adapter, /set_config\('app\.tenant_id'/);
  assert.doesNotMatch(adapter, /app\.current_tenant/);
  assert.match(migration, /deviludo\.current_tenant_id\(\)/);
  assert.doesNotMatch(migration, /app\.current_tenant/);
});

test("workflow action completions use a tenant-isolated transactional signal outbox", () => {
  const migration = readFileSync(new URL("../infra/postgres/012_workflow_signal_outbox.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/control-plane/src/workflow-action-completion-postgres.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.workflow_signal_outbox/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /UNIQUE \(tenant_id, signal_id\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, project_id, workflow_id, action_id\)/);
  assert.match(migration, /UNIQUE \(tenant_id, project_id, workflow_id, id\)/);
  assert.match(adapter, /set_config\('app\.tenant_id'/);
  assert.match(adapter, /INSERT INTO deviludo\.workflow_signal_outbox/);
  assert.match(adapter, /status = 'COMPLETED'/);
});
