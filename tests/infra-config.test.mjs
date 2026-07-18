import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("local integration PostgreSQL applies every migration in order", () => {
  const compose = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  const offsets = Array.from({ length: 18 }, (_, index) => {
    const prefix = String(index + 1).padStart(3, "0");
    const marker = `./postgres/${prefix}_`;
    const offset = compose.indexOf(marker);
    assert.notEqual(offset, -1, `missing PostgreSQL migration ${prefix}`);
    return offset;
  });
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
});

test("Steam install grants are tenant-isolated, expiring and once-per-platform", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/018_steam_install_grants.sql", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/steam-publisher/src/run-clean-install-services.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:steam-install-services"], "node --import tsx services/steam-publisher/src/run-clean-install-services.ts");
  assert.match(migration, /CREATE TABLE deviludo\.steam_install_grants/);
  assert.match(migration, /expires_at <= issued_at \+ interval '24 hours'/);
  assert.match(migration, /UNIQUE \(tenant_id, grant_id, platform\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /steam_install_grant_redemptions_append_only/);
  assert.match(runtime, /preparationPort === redemptionPort/);
  assert.match(runtime, /Promise\.all\(\[runtime\.pool\.probe\(\), runtime\.preparation\.probe\(\), runtime\.redemption\.probe\(\)\]\)/);
  assert.match(runtime, /O_NOFOLLOW/);
});

test("approved specifications bind one append-only Runner toolchain revision", () => {
  const migration = readFileSync(new URL("../infra/postgres/017_runner_toolchain_revisions.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.runner_toolchain_revisions/);
  assert.match(migration, /UNIQUE \(tenant_id, project_id, id, payload_digest\)/);
  assert.match(migration, /runner_toolchain_revisions_append_only/);
  assert.match(migration, /ADD COLUMN runner_toolchain_revision_id uuid NOT NULL/);
  assert.match(migration, /approved_test_plan_runner_toolchain_fk/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
});

test("approved specifications bind one append-only canonical test plan", () => {
  const migration = readFileSync(new URL("../infra/postgres/016_approved_test_plan_bindings.sql", import.meta.url), "utf8");
  const reader = readFileSync(new URL("../services/artifact-preparer/src/postgres-test-plan.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.approved_test_plan_bindings/);
  assert.match(migration, /UNIQUE \(tenant_id, project_id, spec_revision_id\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /approved_test_plan_bindings_append_only/);
  assert.match(reader, /spec\.aggregate_type = 'GAME_SPEC'/);
  assert.match(reader, /plan\.aggregate_type = 'TEST_PLAN'/);
  assert.match(reader, /set_config\('app\.tenant_id'/);
  assert.match(reader, /createHash\("sha256"\)/);
});

test("authoritative GitHub source snapshots are tenant-bound, read-only and mTLS isolated", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const authority = readFileSync(new URL("../services/scm-proxy/src/postgres-source-snapshot-authority.ts", import.meta.url), "utf8");
  const connector = readFileSync(new URL("../services/scm-proxy/src/github-rest.ts", import.meta.url), "utf8");
  const materializer = readFileSync(new URL("../services/scm-proxy/src/github-source-materializer.ts", import.meta.url), "utf8");
  const ingress = readFileSync(new URL("../services/scm-proxy/src/source-snapshot-http.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/scm-proxy/src/run-source-snapshot-service.ts", import.meta.url), "utf8");
  const signer = readFileSync(new URL("../services/scm-proxy/src/github-app-signer-client.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:source-snapshot"], "node --import tsx services/scm-proxy/src/run-source-snapshot-service.ts");
  assert.match(authority, /set_config\('app\.tenant_id'/);
  assert.match(authority, /merge\.main_source_digest = \$5/);
  assert.match(authority, /repository\.status = 'ACTIVE'/);
  assert.match(connector, /"source-read"/);
  assert.match(connector, /permissions: requestedPermissions/);
  assert.match(connector, /gitBlobSha\(content\) !== expectedSha/);
  assert.match(materializer, /constants\.O_NOFOLLOW/);
  assert.match(materializer, /type !== "blob"/);
  assert.match(ingress, /requestCert: true/);
  assert.match(ingress, /rejectUnauthorized: true/);
  assert.match(ingress, /minVersion: "TLSv1\.3"/);
  assert.match(runtime, /new PostgresSourceSnapshotAuthority\(pool\)/);
  assert.match(runtime, /permissionMode: "source-read"/);
  assert.doesNotMatch(runtime, /GITHUB_APP_PRIVATE_KEY/);
  assert.match(signer, /\/v1\/github-app\/sign-rs256/);
  assert.doesNotMatch(signer, /createPrivateKey|PRIVATE KEY/);
});

test("Runner ingress persists replayable signed jobs and immutable lease/event bindings", () => {
  const migration = readFileSync(new URL("../infra/postgres/015_runner_ingress_transactions.sql", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../services/runner-control/src/postgres-ingress.ts", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN job jsonb/);
  assert.match(migration, /runner identity and capabilities are immutable/);
  assert.match(migration, /platform lease binding and signed job are immutable/);
  assert.match(migration, /platform_runner_events_append_only/);
  assert.match(adapter, /FOR UPDATE OF attempt SKIP LOCKED/);
  assert.match(adapter, /attempt\.mode <> 'STEAM_CLEAN_INSTALL' OR \$4::boolean/);
  assert.match(adapter, /runner\.steamClientConnector !== null/);
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
  assert.match(fleet, /steamClientConnectorIdentity/);
  assert.match(fleet, /workload === "runner"/);
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
  assert.match(daemon, /service\.steamConnector\?\.probe\(\)/);
  assert.match(daemon, /STEAM_CONNECTOR_BINARY_DIGEST/);
  assert.match(daemon, /STEAM_AUTOMATION_POLICY_DIGEST/);
});

test("Godot TestKit is a fixed signed-job CLI and part of the full service gate", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const cli = readFileSync(new URL("../services/godot-testkit/src/run-cli.ts", import.meta.url), "utf8");
  const controller = readFileSync(new URL("../services/godot-testkit/src/controller.ts", import.meta.url), "utf8");
  const driver = readFileSync(new URL("../services/godot-testkit/src/godot-driver.ts", import.meta.url), "utf8");
  const steamDriver = readFileSync(new URL("../services/godot-testkit/src/steam-installed-game-driver.ts", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../services/godot-testkit/README.md", import.meta.url), "utf8");
  assert.match(packageJson.scripts["test:services"], /npm run test:godot-testkit/);
  assert.equal(packageJson.scripts["start:godot-testkit"], "node --import tsx services/godot-testkit/src/run-cli.ts");
  assert.match(cli, /parseGodotTestKitRunRequest/);
  assert.match(cli, /basename\(requestPath\) !== "request\.json"/);
  assert.match(controller, /maximumExecutionSeconds \+ 300/);
  assert.match(controller, /exportedFiles\.length > 0/);
  assert.match(driver, /shell: false/);
  assert.match(driver, /--write-movie/);
  assert.match(steamDriver, /\/v1\/clean-install-executions/);
  assert.match(steamDriver, /minVersion: "TLSv1\.3"/);
  assert.match(steamDriver, /execution\.kind !== "STEAM_CLEAN_INSTALL"/);
  assert.match(steamDriver, /deviludo-steam-client-connector/);
  assert.match(steamDriver, /escaped staging root/);
  assert.doesNotMatch(steamDriver, /configVdf|branchPassword|accountPassword|steamGuard/);
  assert.doesNotMatch(driver, /dangerously|--yolo/);
  assert.match(readme, /not a production Runner artifact/);
  assert.match(readme, /signed the native artifacts for all selected Runner systems/);
});

test("Steam Client Connector independently verifies signed clean-install jobs behind mTLS", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const connector = readFileSync(new URL("../services/steam-client-connector/src/connector.ts", import.meta.url), "utf8");
  const ingress = readFileSync(new URL("../services/steam-client-connector/src/ingress-http.ts", import.meta.url), "utf8");
  const native = readFileSync(new URL("../services/steam-client-connector/src/locked-native-executor.ts", import.meta.url), "utf8");
  const nativeController = readFileSync(new URL("../services/steam-client-connector/src/native-bridge-controller.ts", import.meta.url), "utf8");
  const manifest = readFileSync(new URL("../services/steam-client-connector/src/native-bridge-manifest.ts", import.meta.url), "utf8");
  const appManifest = readFileSync(new URL("../services/steam-client-connector/src/steam-appmanifest.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/steam-client-connector/src/run-service.ts", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../services/steam-client-connector/README.md", import.meta.url), "utf8");
  assert.match(packageJson.scripts["test:services"], /npm run test:steam-client-connector/);
  assert.equal(packageJson.scripts["start:steam-client-connector"], "node --import tsx services/steam-client-connector/src/run-service.ts");
  assert.match(connector, /verifyRunnerJob/);
  assert.match(connector, /parseFrozenGodotTestPlan/);
  assert.match(connector, /execution\.kind !== "STEAM_CLEAN_INSTALL"/);
  assert.match(connector, /escaped|staging boundary/);
  assert.match(ingress, /requestCert: true/);
  assert.match(ingress, /rejectUnauthorized: true/);
  assert.match(ingress, /minVersion: "TLSv1\.3"/);
  assert.match(ingress, /allowedSpiffeIds\.has/);
  assert.match(ingress, /deviludo\.steam-client-connector-health\.v2/);
  assert.match(ingress, /\.\.\.options\.healthIdentity/);
  assert.match(connector, /options\.grants\.redeem/);
  assert.ok(connector.indexOf("options.grants.redeem") < connector.indexOf("options.executor.execute"));
  assert.match(native, /shell: false/);
  assert.match(native, /"execute", "--request-file"/);
  assert.match(native, /verifyExecutable/);
  assert.match(manifest, /verifyCanonical/);
  assert.match(manifest, /automationPolicyDigest/);
  assert.match(manifest, /supplyChainEvidenceDigest/);
  assert.match(nativeController, /resetClient/);
  assert.match(nativeController, /installBuild/);
  assert.match(nativeController, /bootProduction/);
  assert.match(nativeController, /runPlatformSuite/);
  assert.match(nativeController, /verifyRunnerJob/);
  assert.match(nativeController, /verifySteamAppManifest/);
  assert.match(appManifest, /StateFlags/);
  assert.match(appManifest, /buildId !== expected\.buildId/);
  assert.match(connector, /appManifest\.manifestDigest/);
  assert.doesNotMatch(native, /process\.env/);
  assert.match(runtime, /platform does not match this host/);
  assert.match(runtime, /automationPolicyDigest: nativeBridge\.automationPolicyDigest/);
  assert.match(runtime, /supplyChainEvidenceDigest: nativeBridge\.supplyChainEvidenceDigest/);
  assert.doesNotMatch(runtime, /NATIVE_EXECUTABLE_DIGEST/);
  assert.doesNotMatch(connector, /configVdf|branchPassword|accountPassword|steamGuard/);
  assert.match(readme, /does not ship\s+Valve credentials/);
});

test("Steam private Beta upload claims are durable, tenant-scoped and immutable", () => {
  const migration = readFileSync(new URL("../infra/postgres/019_steam_publish_claims.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/steam-publisher/src/postgres-publish-operations.ts", import.meta.url), "utf8");
  assert.match(migration, /steam_publish_claim_binding_immutable/);
  assert.match(migration, /completed steam publish claim is immutable/);
  assert.match(migration, /WHERE response IS NULL/);
  assert.match(store, /set_config\('app\.tenant_id'/);
  assert.match(store, /ON CONFLICT \(key\) DO NOTHING/);
  assert.match(store, /FOR UPDATE/);
  assert.match(store, /claim_expires_at/);
  assert.match(store, /sha256Canonical\(existing\)/);
});

test("Steam Workflow Broker persists before dispatch and fences isolated executors", () => {
  const migration = readFileSync(new URL("../infra/postgres/020_steam_workflow_operations.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/steam-publisher/src/postgres-workflow-operations.ts", import.meta.url), "utf8");
  const operations = readFileSync(new URL("../services/steam-publisher/src/workflow-broker-operations.ts", import.meta.url), "utf8");
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /steam workflow operation binding is immutable/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, project_id, run_id\)/);
  assert.match(migration, /terminal steam workflow operation is immutable/);
  assert.match(store, /set_config\('app\.tenant_id'/);
  assert.match(store, /ON CONFLICT \(tenant_id, operation_key\) DO NOTHING/);
  assert.match(store, /claim_expires_at > \$5::timestamptz/);
  assert.ok(operations.indexOf("operations.reserve") < operations.indexOf("dispatcher.enqueue"));
  assert.match(operations, /operations\.heartbeat/);
  assert.match(operations, /operations\.release/);
  assert.doesNotMatch(operations, /configVdf|accountPassword|steamGuard/);
});

test("Steam execution re-resolves signed release authority and archives the tested BuildID", () => {
  const migration = readFileSync(new URL("../infra/postgres/021_steam_release_execution.sql", import.meta.url), "utf8");
  const executor = readFileSync(new URL("../services/steam-publisher/src/workflow-broker-executor.ts", import.meta.url), "utf8");
  const postgres = readFileSync(new URL("../services/steam-publisher/src/postgres-workflow-execution.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.steam_rc_artifacts/);
  assert.match(migration, /CREATE TABLE deviludo\.steam_default_branch_receipts/);
  assert.match(migration, /default_branch_build_id = beta_build_id/);
  assert.match(migration, /steam_default_branch_receipt_append_only/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, project_id, run_id\)/);
  assert.match(postgres, /authorization\.state = 'DISPATCHED'/);
  assert.match(postgres, /build\.state = 'EXTERNAL_APPROVAL_REQUIRED'/);
  assert.match(postgres, /workflow_external_approval_receipts/);
  assert.match(postgres, /set_config\('app\.tenant_id'/);
  assert.ok(executor.indexOf("resolvePrivateBeta") < executor.indexOf("uploadPrivateBeta"));
  assert.ok(executor.indexOf("resolveDefaultBranch") < executor.indexOf("defaultBranch.promote"));
  assert.match(executor, /defaultBranchBuildId !== request\.betaBuildId/);
  assert.doesNotMatch(executor, /accountPassword|guardCode|configVdfBytes/);
});

test("artifact preparation publishes canonical source and plan objects before the append-only lock", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const preparer = readFileSync(new URL("../services/artifact-preparer/src/preparer.ts", import.meta.url), "utf8");
  const postgres = readFileSync(new URL("../services/artifact-preparer/src/postgres-lock-store.ts", import.meta.url), "utf8");
  const authority = readFileSync(new URL("../services/artifact-preparer/src/postgres-preparation-authority.ts", import.meta.url), "utf8");
  const ingress = readFileSync(new URL("../services/artifact-preparer/src/ingress-http.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/artifact-preparer/src/run-service.ts", import.meta.url), "utf8");
  const runnerClient = readFileSync(new URL("../services/runner-control/src/artifact-preparation-client.ts", import.meta.url), "utf8");
  const steamClient = readFileSync(new URL("../services/runner-control/src/steam-install-preparation-client.ts", import.meta.url), "utf8");
  const runnerWorkflow = readFileSync(new URL("../services/runner-control/src/workflow-handler.ts", import.meta.url), "utf8");
  const builder = readFileSync(new URL("../services/godot-testkit/src/source-bundle-builder.ts", import.meta.url), "utf8");
  assert.match(packageJson.scripts["test:services"], /npm run test:artifact-preparer/);
  assert.equal(packageJson.scripts["start:artifact-preparer"], "node --import tsx services/artifact-preparer/src/run-service.ts");
  assert.match(preparer, /Promise\.all\(\[\s*this\.#objects\.publishFile/);
  assert.match(preparer, /exactObjectReceipt\(sourceReceipt/);
  assert.match(preparer, /this\.#locks\.persist/);
  assert.ok(preparer.indexOf("this.#locks.persist") > preparer.indexOf("exactObjectReceipt(sourceReceipt"));
  assert.match(postgres, /set_config\('app\.tenant_id'/);
  assert.match(postgres, /ON CONFLICT \(tenant_id, lock_key\) DO NOTHING/);
  assert.match(authority, /FOR SHARE OF run, spec, binding, toolchain/);
  assert.match(authority, /set_config\('app\.tenant_id'/);
  assert.match(authority, /sha256Canonical\(row\.toolchain_payload\)/);
  assert.match(ingress, /requestCert: true/);
  assert.match(ingress, /rejectUnauthorized: true/);
  assert.match(ingress, /minVersion: "TLSv1\.3"/);
  assert.match(runtime, /new PostgresSourceExecutionPreparationAuthority\(pool\)/);
  assert.match(runnerClient, /deviludo\.source-execution-preparation-trigger\.v1/);
  assert.match(steamClient, /deviludo\.steam-clean-install-preparation-trigger\.v1/);
  assert.doesNotMatch(steamClient, /configVdf|branchPassword|accountPassword/);
  assert.match(runnerWorkflow, /withLeaseHeartbeats/);
  assert.match(runnerWorkflow, /this\.steamInstalls\.prepare/);
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
