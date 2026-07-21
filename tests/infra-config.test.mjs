import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const observedServiceCommand = (service) =>
  `node --import tsx scripts/observability/run-service.mjs ${service}`;

test("local integration PostgreSQL applies every migration in order", () => {
  const compose = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  const offsets = Array.from({ length: 52 }, (_, index) => {
    const prefix = String(index + 1).padStart(3, "0");
    const marker = `./postgres/${prefix}_`;
    const offset = compose.indexOf(marker);
    assert.notEqual(offset, -1, `missing PostgreSQL migration ${prefix}`);
    return offset;
  });
  assert.deepEqual(offsets, [...offsets].sort((left, right) => left - right));
});

test("Provider recovery probes only the exact immutable waiting Run binding", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/052_provider_recovery_checks.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/provider-monitor/src/postgres-store.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/provider-monitor/src/service.ts", import.meta.url), "utf8");
  const ingress = readFileSync(new URL("../services/provider-monitor/src/ingress-http.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:provider-monitor"], observedServiceCommand("provider-monitor"));
  assert.match(packageJson.scripts["test:services"], /npm run test:provider-monitor/);
  assert.match(migration, /CREATE TABLE deviludo\.provider_recovery_checks/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /UNIQUE \(tenant_id, project_id, action_id\)/);
  assert.doesNotMatch(migration, /api_key|raw_response|access_token|password/i);
  assert.match(store, /SELECT set_config\('app\.tenant_id'/);
  assert.match(store, /action\.binding->>'lockedRunConfigurationId'/);
  assert.match(store, /failover\.to_provider_revision_id/);
  assert.match(store, /provider\.provider_revision_id = action\.binding->>'providerRevisionId'/);
  assert.match(service, /source: "PROVIDER_MONITOR"/);
  assert.match(service, /type: "PROVIDER_RESTORED"/);
  assert.match(ingress, /requestCert: true/);
  assert.match(ingress, /rejectUnauthorized: true/);
  assert.match(ingress, /minVersion: "TLSv1\.3"/);
});

test("Steam external approvals require a current mTLS verifier observation and passed clean-install authority", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/051_steam_external_approval_observations.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/steam-approval-monitor/src/postgres-store.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/steam-approval-monitor/src/service.ts", import.meta.url), "utf8");
  const ingress = readFileSync(new URL("../services/steam-approval-monitor/src/ingress-http.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:steam-approval-monitor"], observedServiceCommand("steam-approval-monitor"));
  assert.match(packageJson.scripts["test:services"], /npm run test:steam-approval-monitor/);
  assert.match(migration, /CREATE TABLE deviludo\.steam_external_approval_observations/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /steam_external_approval_observation_guard/);
  assert.match(migration, /UNIQUE \(tenant_id, project_id, action_id\)/);
  assert.doesNotMatch(migration, /raw_response|access_token|password|config_vdf/i);
  assert.match(store, /SELECT set_config\('app\.tenant_id'/);
  assert.match(store, /action\.operation AS action_operation/);
  assert.match(store, /build\.steam_install_evidence_bundle_digest/);
  assert.match(store, /attempt\.mode AS attempt_mode/);
  assert.match(store, /FOR UPDATE OF action, release, build/);
  assert.match(service, /source: "STEAM_APPROVAL_MONITOR"/);
  assert.match(service, /type: "EXTERNAL_APPROVED"/);
  assert.match(ingress, /requestCert: true/);
  assert.match(ingress, /rejectUnauthorized: true/);
  assert.match(ingress, /minVersion: "TLSv1\.3"/);
});

test("project creation binds a live GitHub repository under tenant RLS and a durable claim", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/043_project_repository_onboarding.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/scm-proxy/src/project-repository-postgres.ts", import.meta.url), "utf8");
  const github = readFileSync(new URL("../services/scm-proxy/src/github-repository-catalog.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/scm-proxy/src/run-project-repository-service.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:project-repository"], observedServiceCommand("project-repository"));
  assert.match(migration, /CREATE TABLE deviludo\.project_creation_operations/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /project_creation_terminal_guard/);
  assert.match(store, /SELECT set_config\('app\.tenant_id'/);
  assert.match(store, /verified_by_github_user_id = \$3::bigint/);
  assert.match(store, /INSERT INTO deviludo\.projects/);
  assert.match(store, /INSERT INTO deviludo\.github_repository_bindings/);
  assert.match(store, /project\.created_by = \$3/);
  assert.match(store, /installation\.verified_by_github_user_id = \$4::bigint/);
  assert.match(github, /permissions: \{ metadata: "read" \}/);
  assert.match(github, /DELETE", "\/installation\/token"/);
  assert.match(runtime, /minVersion: "TLSv1\.3"/);
  assert.match(runtime, /workflowSpiffeIdFromAuthorizedTls/);
});

test("Temporal projects replay-validated delivery state for production Web reads", () => {
  const migration = readFileSync(new URL("../infra/postgres/041_delivery_state_projections.sql", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../services/temporal/src/workflows/game-delivery.workflow.ts", import.meta.url), "utf8");
  const projection = readFileSync(new URL("../lib/orchestration/delivery-projection.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.delivery_state_projection_events/);
  assert.match(migration, /CREATE TABLE deviludo\.delivery_state_projections/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /NEW\.projection_sequence <> OLD\.projection_sequence \+ 1/);
  assert.match(migration, /delivery_state_projection_event_append_only/);
  assert.match(workflow, /persistDeliverySnapshot/);
  assert.match(workflow, /await persist\(machine\.current\(\)/);
  assert.match(projection, /machine\.signal\(signal\)/);
  assert.match(projection, /canonicalJson\(replayed\) !== canonicalJson\(candidate\)/);
});

test("GitHub authorization production host is tenant-isolated, anti-replay and secret-brokered", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/042_github_authorization_request_ledger.sql", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/scm-proxy/src/run-github-authorization-service.ts", import.meta.url), "utf8");
  const ledger = readFileSync(new URL("../services/scm-proxy/src/github-auth-ledger-postgres.ts", import.meta.url), "utf8");
  const secrets = readFileSync(new URL("../services/scm-proxy/src/github-auth-secret-client.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:github-authorization"], observedServiceCommand("github-authorization"));
  assert.match(migration, /CREATE TABLE deviludo\.github_authorization_request_ledger/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /stores no response body/i);
  assert.doesNotMatch(migration, /response jsonb/);
  assert.match(runtime, /minVersion: "TLSv1\.3"/);
  assert.match(runtime, /workflowSpiffeIdFromAuthorizedTls/);
  assert.match(runtime, /PostgresGitHubBrokerRequestLedger/);
  assert.match(ledger, /SELECT set_config\('app\.tenant_id'/);
  assert.doesNotMatch(ledger, /JSON\.stringify\(result\)[\s\S]*client\.query/);
  assert.match(secrets, /application\/octet-stream/);
  assert.match(secrets, /response\.payload\.fill\(0\)/);
});

test("Secret Broker is the isolated Vault authority for PKCE and inference credentials", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/045_secret_broker.sql", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/secret-broker/src/run-service.ts", import.meta.url), "utf8");
  const http = readFileSync(new URL("../services/secret-broker/src/http.ts", import.meta.url), "utf8");
  const authority = readFileSync(new URL("../services/secret-broker/src/authority.ts", import.meta.url), "utf8");
  const vault = readFileSync(new URL("../services/secret-broker/src/vault-backend.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../services/control-plane/src/secret-vault.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:secret-broker"], observedServiceCommand("secret-broker"));
  assert.match(migration, /CREATE TABLE deviludo\.secret_broker_records/);
  assert.match(migration, /CREATE TABLE deviludo\.secret_broker_audit/);
  assert.match(migration, /secret_broker_record_no_delete/);
  assert.match(migration, /secret_broker_audit_append_only/);
  assert.doesNotMatch(migration, /plaintext\s+(?:text|bytea)/i);
  assert.match(runtime, /DEVILUDO_SECRET_BROKER_VAULT_TOKEN_FILE/);
  assert.match(runtime, /O_NOFOLLOW/);
  assert.match(http, /requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1\.3"/);
  assert.match(http, /requireIdempotencyKey/);
  assert.match(authority, /SELECT set_config\('app\.tenant_id'/);
  assert.match(authority, /inference_run_authorizations/);
  assert.match(vault, /options: \{ cas: 0 \}/);
  assert.match(vault, /metadataPath/);
  assert.match(client, /httpsRequest/);
  assert.doesNotMatch(client, /\bfetch\s*\(/);
});

test("SCM merge authority binds one delivered acceptance to GitHub and merged-main evidence", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/040_scm_authoritative_merges.sql", import.meta.url), "utf8");
  const authority = readFileSync(new URL("../services/scm-proxy/src/postgres-merge.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/scm-proxy/src/run-merge-service.ts", import.meta.url), "utf8");
  const signer = readFileSync(new URL("../services/scm-proxy/src/acceptance-signer-client.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:scm-merge-broker"], observedServiceCommand("scm-merge-broker"));
  assert.match(migration, /acceptance_operation_key/);
  assert.match(migration, /evidence_bundle_id/);
  assert.match(migration, /workflow_request_digest/);
  assert.match(migration, /github_merge_receipt_acceptance_fk/);
  assert.match(authority, /workflow_signal_outbox signal/);
  assert.match(authority, /signal\.state = 'DELIVERED'/);
  assert.match(authority, /evidence\.invalidated_at IS NULL/);
  assert.match(authority, /attempt\.mode = 'CANDIDATE'/);
  assert.match(authority, /job\.state = 'RUNNING'/);
  assert.match(runtime, /permissionMode: "scm-write"/);
  assert.doesNotMatch(runtime, /GITHUB_APP_PRIVATE_KEY|createPrivateKey/);
  assert.match(signer, /github-candidate-acceptance\/sign-ed25519/);
});

test("candidate acceptance is an immutable actor and evidence-bound decision", () => {
  const migration = readFileSync(new URL("../infra/postgres/039_user_candidate_acceptances.sql", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/user-acceptance/src/candidate-acceptance.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.user_candidate_acceptances/);
  assert.match(migration, /candidate_commit_sha/);
  assert.match(migration, /evidence_bundle_id/);
  assert.match(migration, /user_candidate_acceptance_guard/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(service, /action\.operation = 'REQUEST_USER_ACCEPTANCE'/);
  assert.match(service, /evidence\.invalidated_at IS NULL/);
  assert.match(service, /attempt\.binding->>'specRevisionId' = spec\.id::text/);
  assert.match(service, /evidence\.binding->>'specRevisionId' = spec\.id::text/);
  assert.match(service, /source: "USER_ACCEPTANCE_SERVICE"/);
  assert.match(service, /type: "USER_ACCEPTED"/);
});

test("user feedback generation is durable and cannot invalidate evidence before a draft exists", () => {
  const migration = readFileSync(new URL("../infra/postgres/038_user_feedback_iterations.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/user-acceptance/src/postgres-store.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/user-acceptance/src/service.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.user_feedback_operations/);
  assert.match(migration, /state IN \('GENERATING', 'DRAFT_READY', 'COMPLETED'\)/);
  assert.match(migration, /user_feedback_operation_guard/);
  assert.match(migration, /previous_spec_revision_id/);
  assert.match(migration, /next_spec_revision_id/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(store, /action\.operation = 'REQUEST_USER_ACCEPTANCE'/);
  assert.match(store, /action\.status = 'WAITING'/);
  assert.match(store, /NOT EXISTS[\s\S]*draft\.state = 'DRAFT'/);
  assert.match(store, /previousRevisionId: claim\.previousSpecRevisionId/);
  assert.match(store, /INSERT INTO deviludo\.spec_dialogue_operations/);
  assert.match(store, /SET state = 'DRAFT_READY'/);
  assert.match(service, /source: "USER_ACCEPTANCE_SERVICE"/);
  assert.match(service, /type: "USER_FEEDBACK"/);
});

test("user feedback atomically invalidates the candidate evidence through an append-only receipt", () => {
  const migration = readFileSync(new URL("../infra/postgres/037_feedback_evidence_invalidation.sql", import.meta.url), "utf8");
  const completion = readFileSync(new URL("../services/control-plane/src/workflow-action-completion-postgres.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.workflow_feedback_invalidations/);
  assert.match(migration, /workflow_feedback_invalidations_append_only/);
  assert.match(migration, /UNIQUE \(tenant_id, project_id, evidence_bundle_id\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(completion, /UPDATE deviludo\.evidence_bundles/);
  assert.match(completion, /evidence\.invalidated_at IS NULL/);
  assert.match(completion, /next\.previous_revision_id/);
});

test("approved specifications enter Temporal through an ordered durable bridge", () => {
  const migration = readFileSync(new URL("../infra/postgres/032_spec_workflow_bridge.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/spec-workflow-bridge/src/postgres-store.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/spec-workflow-bridge/src/service.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.spec_delivery_workflows/);
  assert.match(migration, /CREATE TABLE deviludo\.spec_workflow_events/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /spec_workflow_event_guard/);
  assert.match(migration, /RESOLVE_AGENT_RUN_CONFIGURATION/);
  assert.match(store, /SELECT set_config\('app\.tenant_id'/);
  assert.match(store, /ready\.state = 'COMPLETED'/);
  assert.match(store, /FOR UPDATE OF event SKIP LOCKED/);
  assert.match(service, /source: "SPEC_SERVICE"/);
  assert.match(service, /approvedSpecRevisionId/);
  assert.doesNotMatch(service, /RUN_CONFIGURATION_LOCKED/);
});

test("approved specifications lock one tenant-bound source and Agent catalog revision", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/033_agent_configuration_resolution.sql", import.meta.url), "utf8");
  const inferenceProjection = readFileSync(new URL("../infra/postgres/034_inference_provider_projection.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/agent-configuration/src/postgres-store.ts", import.meta.url), "utf8");
  const resolver = readFileSync(new URL("../services/agent-configuration/src/catalog.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/agent-configuration/src/service.ts", import.meta.url), "utf8");
  const baseline = readFileSync(new URL("../services/scm-proxy/src/source-baseline-postgres.ts", import.meta.url), "utf8");
  const ingress = readFileSync(new URL("../services/scm-proxy/src/source-snapshot-http.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:agent-configuration"], observedServiceCommand("agent-configuration"));
  assert.match(migration, /CREATE TABLE deviludo\.github_source_baseline_receipts/);
  assert.match(migration, /CREATE TABLE deviludo\.agent_configuration_resolutions/);
  assert.match(migration, /immutable_revisions_tenant_project_id_unique/);
  assert.match(migration, /agent_run_configuration_shape/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(resolver, /project:\$\{input\.projectId\}/);
  assert.match(resolver, /tenant:\$\{input\.tenantId\}/);
  assert.match(store, /CROSS JOIN deviludo\.admin_catalog_state catalog/);
  assert.match(store, /INSERT INTO deviludo\.agent_runs/);
  assert.match(store, /INSERT INTO deviludo\.inference_provider_revisions/);
  assert.match(store, /INSERT INTO deviludo\.inference_run_authorizations/);
  assert.match(store, /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/);
  assert.match(store, /SELECT set_config\('app\.tenant_id'/);
  assert.match(service, /source: "AGENT_CONFIGURATION_SERVICE"/);
  assert.match(service, /RUN_CONFIGURATION_LOCKED/);
  assert.match(baseline, /repository\.status = 'ACTIVE'/);
  assert.match(baseline, /spec\.state = 'APPROVED'/);
  assert.match(ingress, /baselineSpiffeIds/);
  assert.match(ingress, /idempotency-key/);
  assert.match(inferenceProjection, /PRIMARY KEY \(tenant_id, provider_revision_id\)/);
  assert.match(inferenceProjection, /inference_run_authorization_agent_run_fk/);
});

test("project-approved Agent fallback is append-only and shared by execution and inference authority", () => {
  const migration = readFileSync(new URL("../infra/postgres/046_agent_run_provider_failovers.sql", import.meta.url), "utf8");
  const auditMigration = readFileSync(new URL("../infra/postgres/047_agent_run_provider_failover_audit.sql", import.meta.url), "utf8");
  const execution = readFileSync(new URL("../services/agent-execution-broker/src/postgres-operations.ts", import.meta.url), "utf8");
  const gateway = readFileSync(new URL("../services/inference-gateway/src/postgres-store.ts", import.meta.url), "utf8");
  const secrets = readFileSync(new URL("../services/secret-broker/src/authority.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.agent_run_provider_failovers/);
  assert.match(migration, /locked->>'profileSource' <> \('project:'/);
  assert.match(migration, /locked->>'agent' <> fallback->>'agent'/);
  assert.match(migration, /primary_provider_state = 'ACTIVE'/);
  assert.match(migration, /claim\.state IN \('ACTIVE', 'INDETERMINATE'\)/);
  assert.match(migration, /agent_run_provider_failover_append_only/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(execution, /INSERT INTO deviludo\.agent_run_provider_failovers/);
  assert.match(gateway, /LEFT JOIN deviludo\.agent_run_provider_failovers/);
  assert.match(secrets, /LEFT JOIN deviludo\.agent_run_provider_failovers/);
  assert.doesNotMatch(execution, /UPDATE deviludo\.inference_run_authorizations SET provider_revision_id/);
  assert.match(auditMigration, /AGENT_RUN_PROVIDER_FAILOVER_ACTIVATED/);
  assert.match(auditMigration, /actor_role[\s\S]*'System'/);
  assert.match(auditMigration, /AFTER INSERT ON deviludo\.agent_run_provider_failovers/);
  assert.match(auditMigration, /INSERT INTO deviludo\.admin_audit_records/);
  assert.doesNotMatch(auditMigration, /authorization_nonce/);
});

test("specification dialogue persists tenant-isolated messages and immutable draft pairs", () => {
  const migration = readFileSync(new URL("../infra/postgres/031_spec_dialogue.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/spec-dialogue/src/postgres-store.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/spec-dialogue/src/run-service.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.spec_conversations/);
  assert.match(migration, /CREATE TABLE deviludo\.spec_dialogue_operations/);
  assert.match(migration, /CREATE TABLE deviludo\.spec_conversation_messages/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /spec_conversation_messages_append_only/);
  assert.match(store, /INSERT INTO deviludo\.immutable_revisions/);
  assert.match(store, /aggregateType: "GAME_SPEC"/);
  assert.match(store, /aggregateType: "TEST_PLAN"/);
  assert.match(store, /state: "APPROVED"/);
  assert.match(store, /state: "FROZEN"/);
  assert.match(store, /INSERT INTO deviludo\.approved_test_plan_bindings/);
  assert.match(store, /spec\.aggregate_id !== conversation\.specAggregateId/);
  assert.match(store, /SELECT set_config\('app\.tenant_id'/);
  assert.match(runtime, /DEVILUDO_SPEC_DIALOGUE_WEB_SPIFFE_IDS/);
  assert.match(runtime, /DEVILUDO_SPEC_MODEL_BROKER_TLS_KEY_FILE/);
  assert.doesNotMatch(runtime, /ANTHROPIC_API_KEY|OPENAI_API_KEY|apiKey/);
});

test("ambiguous inference usage has one SecurityAdmin-only evidence-bound reconciliation path", () => {
  const migration = readFileSync(new URL("../infra/postgres/030_inference_reconciliation.sql", import.meta.url), "utf8");
  const controller = readFileSync(new URL("../services/control-plane/src/admin.controller.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../services/control-plane/src/inference-reconciliation.ts", import.meta.url), "utf8");
  const gateway = readFileSync(new URL("../services/inference-gateway/src/http.ts", import.meta.url), "utf8");
  assert.match(migration, /reconciliation_operation_key/);
  assert.match(migration, /inference_reconciliation_operation_key_unique/);
  assert.match(migration, /DROP INDEX deviludo\.inference_one_active_request_per_run/);
  assert.match(migration, /DROP INDEX deviludo\.inference_one_indeterminate_request_per_run/);
  assert.match(migration, /CREATE UNIQUE INDEX inference_one_unresolved_request_per_run[\s\S]*WHERE state IN \('ACTIVE', 'INDETERMINATE'\)/);
  assert.match(migration, /CONFIRM_NO_USAGE/);
  assert.match(migration, /RECORD_USAGE/);
  assert.match(controller, /inference-requests\/:id\/reconcile/);
  assert.match(controller, /inference-runs\/:tenantId\/:runId\/reconciliation/);
  assert.match(controller, /\["SecurityAdmin"\]/);
  assert.match(client, /DEVILUDO_INFERENCE_RECONCILIATION_TLS_KEY_FILE/);
  assert.match(gateway, /authorizeReconciliation/);
  assert.match(gateway, /inference-reconciliations\/lookup/);
});

test("Inference Gateway serializes each run and fails closed on ambiguous usage", () => {
  const migration = readFileSync(new URL("../infra/postgres/029_inference_request_claims.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/inference-gateway/src/postgres-store.ts", import.meta.url), "utf8");
  const connector = readFileSync(new URL("../services/inference-gateway/src/production-connector.ts", import.meta.url), "utf8");
  assert.match(migration, /inference_one_active_request_per_run/);
  assert.match(migration, /state IN \('ACTIVE', 'COMPLETED', 'RELEASED', 'INDETERMINATE'\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /inference_usage_request_claim_fk/);
  assert.ok(store.indexOf("FROM deviludo.inference_run_authorizations") < store.indexOf("FROM deviludo.inference_request_claims"));
  assert.match(store, /SET state = 'INDETERMINATE'/);
  assert.match(connector, /usage\.abandon\(claim\)/);
  assert.match(connector, /RUN_INFERENCE_RECONCILIATION_REQUIRED/);
});

test("Steam release lifecycle advances only from authoritative persisted evidence", () => {
  const migration = readFileSync(new URL("../infra/postgres/025_steam_release_lifecycle.sql", import.meta.url), "utf8");
  const revocationMigration = readFileSync(new URL("../infra/postgres/048_steam_install_failure_revocations.sql", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../services/runner-control/src/postgres-workflow.ts", import.meta.url), "utf8");
  const completion = readFileSync(new URL("../services/control-plane/src/workflow-action-completion-postgres.ts", import.meta.url), "utf8");
  const execution = readFileSync(new URL("../services/steam-publisher/src/postgres-workflow-execution.ts", import.meta.url), "utf8");
  assert.match(migration, /steam_release_external_gate_shape/);
  assert.match(migration, /VALVE_REVIEW'[\s\S]+FIRST_RELEASE'[\s\S]+DEFAULT_BRANCH_CONFIRMATION/);
  assert.match(migration, /NEW\.version <> OLD\.version \+ 1/);
  assert.match(runner, /#projectSteamInstallEvidence/);
  assert.match(runner, /steam_install_evidence_bundle_digest = \$4/);
  assert.match(revocationMigration, /CREATE TABLE deviludo\.steam_release_revocations/);
  assert.match(revocationMigration, /steam_release_revocations_append_only/);
  assert.match(revocationMigration, /FORCE ROW LEVEL SECURITY/);
  assert.match(revocationMigration, /state IN \('INSTALL_TESTING', 'EXTERNAL_APPROVAL_REQUIRED', 'FAILED'\)/);
  assert.match(revocationMigration, /steam build failure has no revocation receipt/i);
  assert.match(runner, /#projectSteamInstallFailure/);
  assert.match(runner, /STEAM_INSTALL_FAILURE_REVOCATION_RECEIPT_CONFLICT/);
  assert.match(completion, /INSERT INTO deviludo\.workflow_external_approval_receipts/);
  assert.match(completion, /ON CONFLICT \(release_id, gate\) DO NOTHING/);
  assert.match(execution, /SET state = 'INSTALL_TESTING'/);
  assert.match(execution, /SET state = 'RELEASED'/);
});

test("delivery cancellation atomically fences Agent, Runner and Steam authorities", () => {
  const migration = readFileSync(new URL("../infra/postgres/049_delivery_cancellation_revocations.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/control-plane/src/workflow-action-postgres.ts", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../lib/orchestration/game-delivery.ts", import.meta.url), "utf8");
  const agentOperations = readFileSync(new URL("../services/agent-execution-broker/src/postgres-operations.ts", import.meta.url), "utf8");
  const runnerIngress = readFileSync(new URL("../services/runner-control/src/postgres-ingress.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.delivery_cancellation_revocations/);
  assert.match(migration, /delivery_cancellation_revocations_append_only/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /UPDATE deviludo\.agent_execution_operations[\s\S]+state = 'CANCELLED'/);
  assert.match(migration, /UPDATE deviludo\.inference_run_authorizations[\s\S]+state = 'REVOKED'/);
  assert.match(migration, /UPDATE deviludo\.e2e_platform_leases[\s\S]+state = 'INVALIDATED'/);
  assert.match(migration, /UPDATE deviludo\.workflow_command_jobs[\s\S]+state = 'CANCELLED'/);
  assert.match(migration, /UPDATE deviludo\.steam_releases[\s\S]+state = 'CANCELLED'/);
  assert.match(migration, /cancelled Steam release cannot acquire a publish claim/);
  assert.match(store, /Delivery cancellation revocation idempotency binding mismatch/);
  assert.match(workflow, /READY_TO_PUBLISH" \|\| this\.snapshot\.state === "RELEASED/);
  assert.match(agentOperations, /AND state = 'RUNNING'[\s\S]+AND claim_token = \$7::uuid/);
  assert.match(runnerIngress, /lease\.state !== "RUNNING"/);
});

test("project-owner cancellation is projection-bound before Temporal receives authority", () => {
  const migration = readFileSync(new URL("../infra/postgres/050_delivery_cancellation_requests.sql", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/user-acceptance/src/delivery-cancellation.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/user-acceptance/src/run-service.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/projects/[projectId]/delivery/route.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.delivery_cancellation_requests/);
  assert.match(migration, /REFERENCES deviludo\.delivery_state_projection_events/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /delivery_cancellation_request_guard/);
  assert.match(migration, /mark_cancelled_delivery_workflow_terminal/);
  assert.match(service, /projection\.state NOT IN \('READY_TO_PUBLISH', 'RELEASED', 'CANCELLED'\)/);
  assert.match(service, /FOR SHARE OF projection, delivery, membership/);
  assert.match(service, /expectedHistoryLength: decision\.projectionSequence/);
  assert.match(runtime, /new TemporalWorkflowSignalPort/);
  assert.match(route, /deliveryCancellationOperationKey/);
  assert.match(route, /verifyTrustedSpecSession/);
  assert.doesNotMatch(route, /workflowId:\s*body\./);
});

test("Steam install grants are tenant-isolated, expiring and once-per-platform", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/018_steam_install_grants.sql", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/steam-publisher/src/run-clean-install-services.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:steam-install-services"], observedServiceCommand("steam-install-services"));
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
  assert.equal(packageJson.scripts["start:source-snapshot"], observedServiceCommand("source-snapshot"));
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
  assert.equal(packageJson.scripts["start:runner-ingress"], observedServiceCommand("runner-ingress"));
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
  assert.equal(packageJson.scripts["start:physical-runner"], observedServiceCommand("physical-runner"));
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
  assert.equal(packageJson.scripts["start:godot-testkit"], observedServiceCommand("godot-testkit"));
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
  assert.equal(packageJson.scripts["start:steam-client-connector"], observedServiceCommand("steam-client-connector"));
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

test("Steam Workflow Broker production host uses a recoverable RLS outbox and credential-free mTLS ingress", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/022_steam_workflow_dispatch.sql", import.meta.url), "utf8");
  const dispatch = readFileSync(new URL("../services/steam-publisher/src/postgres-workflow-dispatch.ts", import.meta.url), "utf8");
  const broker = readFileSync(new URL("../services/steam-publisher/src/run-workflow-broker-service.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../services/steam-publisher/src/run-workflow-worker.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:steam-workflow-broker"], observedServiceCommand("steam-workflow-broker"));
  assert.match(migration, /available_at timestamptz/);
  assert.match(migration, /enqueue_count integer/);
  assert.match(migration, /steam_workflow_operation_poll_idx/);
  assert.doesNotMatch(migration, /UPDATE deviludo\.steam_workflow_operations/);
  assert.match(dispatch, /FOR UPDATE SKIP LOCKED/);
  assert.match(dispatch, /SELECT set_config\('app\.tenant_id'/);
  assert.doesNotMatch(dispatch, /request_payload|configVdf|accountPassword|steamGuard/);
  assert.match(broker, /createSteamWorkflowBrokerHttpsServer/);
  assert.match(broker, /O_NOFOLLOW/);
  assert.match(broker, /new DurableSteamWorkflowOperationService\(operations, dispatch\)/);
  assert.doesNotMatch(broker, /configVdf|accountPassword|guardCode|branchPassword/);
  assert.match(worker, /new SteamWorkflowOperationWorker\(operations, executor/);
  assert.doesNotMatch(worker, /import\(|exec\(|spawn\(|shell:/);
});

test("isolated Steam execution worker pins native, PostgreSQL, S3 and KMS authority", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL("../infra/postgres/026_steam_clean_install_reservations.sql", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/steam-publisher/src/run-workflow-executor-service.ts", import.meta.url), "utf8");
  const native = readFileSync(new URL("../services/steam-publisher/src/locked-native-publisher.ts", import.meta.url), "utf8");
  const evidence = readFileSync(new URL("../services/steam-publisher/src/postgres-release-evidence.ts", import.meta.url), "utf8");
  const reservations = readFileSync(new URL("../services/steam-publisher/src/postgres-clean-install-dispatch.ts", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["start:steam-workflow-executor"], observedServiceCommand("steam-workflow-executor"));
  assert.match(migration, /CREATE TABLE deviludo\.steam_clean_install_reservations/);
  assert.match(migration, /UNIQUE \(release_id, platform\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(runtime, /new LockedNativeSteamPublisherConnector/);
  assert.match(runtime, /new MtlsSteamRcArtifactSigner/);
  assert.match(runtime, /new S3SteamRcObjectInspector/);
  assert.match(runtime, /new PostgresSteamWorkflowExecutionAuthority/);
  assert.match(runtime, /steamWorkflowWorkerFromEnv\(composition\.executor, env, pool\)/);
  assert.match(runtime, /O_NOFOLLOW/);
  assert.doesNotMatch(runtime, /accountPassword|guardCode|configVdfBytes|curl \| sh/);
  assert.match(native, /execFile\(executable/);
  assert.match(native, /shell: false/);
  assert.match(native, /verifyFile\(this\.#executable, this\.#executableDigest/);
  assert.match(evidence, /attempt\.mode = 'MAIN_RELEASE_GATE'/);
  assert.match(evidence, /evidence\.invalidated_at IS NULL/);
  assert.match(reservations, /ON CONFLICT \(release_id, platform\) DO NOTHING/);
  assert.match(reservations, /set_config\('app\.tenant_id'/);
});

test("Steam execution re-resolves signed release authority and archives the tested BuildID", () => {
  const migration = readFileSync(new URL("../infra/postgres/021_steam_release_execution.sql", import.meta.url), "utf8");
  const issuanceMigration = readFileSync(new URL("../infra/postgres/023_steam_rc_issuance.sql", import.meta.url), "utf8");
  const preparationMigration = readFileSync(new URL("../infra/postgres/024_steam_release_preparation.sql", import.meta.url), "utf8");
  const executor = readFileSync(new URL("../services/steam-publisher/src/workflow-broker-executor.ts", import.meta.url), "utf8");
  const issuance = readFileSync(new URL("../services/steam-publisher/src/postgres-rc-issuance.ts", import.meta.url), "utf8");
  const lifecycle = readFileSync(new URL("../services/steam-publisher/src/postgres-release-lifecycle.ts", import.meta.url), "utf8");
  const controlHandler = readFileSync(new URL("../services/control-plane/src/workflow-handler.ts", import.meta.url), "utf8");
  const controlRuntime = readFileSync(new URL("../services/control-plane/src/run-workflow-service.ts", import.meta.url), "utf8");
  const postgres = readFileSync(new URL("../services/steam-publisher/src/postgres-workflow-execution.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.steam_rc_artifacts/);
  assert.match(migration, /CREATE TABLE deviludo\.steam_default_branch_receipts/);
  const rcTable = migration.slice(
    migration.indexOf("CREATE TABLE deviludo.steam_rc_artifacts"),
    migration.indexOf("CREATE TABLE deviludo.steam_default_branch_receipts"),
  );
  assert.equal((rcTable.match(/run_id uuid NOT NULL/g) ?? []).length, 1);
  assert.match(migration, /CREATE TABLE deviludo\.steam_default_branch_receipts \([\s\S]*?run_id uuid NOT NULL/);
  assert.match(migration, /default_branch_build_id = beta_build_id/);
  assert.match(migration, /steam_default_branch_receipt_append_only/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, project_id, run_id\)/);
  assert.match(issuanceMigration, /CREATE TABLE deviludo\.steam_project_depot_configurations/);
  assert.match(issuanceMigration, /CREATE UNIQUE INDEX steam_project_depot_configuration_active_idx/);
  assert.match(issuanceMigration, /steam_project_depot_configuration_no_delete/);
  assert.match(issuanceMigration, /FORCE ROW LEVEL SECURITY/);
  assert.match(issuanceMigration, /ADD COLUMN depot_configuration_id uuid/);
  assert.match(preparationMigration, /CREATE TABLE deviludo\.steam_project_release_configurations/);
  assert.match(preparationMigration, /ALTER COLUMN mfa_approval_id DROP NOT NULL/);
  assert.match(preparationMigration, /steam_release_workflow_idx/);
  assert.match(preparationMigration, /OLD\.state = 'WAITING_MFA' AND NEW\.state = 'STEAM_PRIVATE_BETA'/);
  assert.match(preparationMigration, /FORCE ROW LEVEL SECURITY/);
  assert.match(lifecycle, /attempt\.mode = 'MAIN_RELEASE_GATE'/);
  assert.match(lifecycle, /ON CONFLICT \(tenant_id, workflow_id\)/);
  assert.match(lifecycle, /authorization\.state = 'DISPATCHED'/);
  assert.match(lifecycle, /set_config\('app\.tenant_id'/);
  assert.match(controlHandler, /this\.releases\.ensure/);
  assert.match(controlRuntime, /new PostgresSteamReleasePreparation\(pool\)/);
  assert.match(issuance, /runnerArtifactObjectKey/);
  assert.match(issuance, /depot\.id = release_configuration\.depot_configuration_id/);
  assert.match(issuance, /ON CONFLICT \(tenant_id, release_id\) DO NOTHING/);
  assert.match(issuance, /set_config\('app\.tenant_id'/);
  assert.match(postgres, /authorization\.state = 'DISPATCHED'/);
  assert.match(postgres, /build\.state = 'EXTERNAL_APPROVAL_REQUIRED'/);
  assert.match(postgres, /workflow_external_approval_receipts/);
  assert.match(postgres, /set_config\('app\.tenant_id'/);
  const uploadMethod = executor.slice(executor.indexOf("async #upload"), executor.indexOf("async #publish"));
  const publishMethod = executor.slice(executor.indexOf("async #publish"));
  assert.ok(uploadMethod.indexOf("releasePreparer.prepare") < uploadMethod.indexOf("rcPreparer.ensure"));
  assert.ok(uploadMethod.indexOf("rcPreparer.ensure") < uploadMethod.indexOf("resolvePrivateBeta"));
  assert.ok(uploadMethod.indexOf("resolvePrivateBeta") < uploadMethod.indexOf("uploadPrivateBeta"));
  assert.ok(publishMethod.indexOf("resolveDefaultBranch") < publishMethod.indexOf("defaultBranch.promote"));
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
  assert.equal(packageJson.scripts["start:artifact-preparer"], observedServiceCommand("artifact-preparer"));
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

test("production Agent administration trusts only pinned mTLS supply-chain Broker receipts", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const client = readFileSync(new URL("../services/control-plane/src/agent-supply-chain.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../services/control-plane/src/admin.service.ts", import.meta.url), "utf8");
  const moduleSource = readFileSync(new URL("../services/control-plane/src/app.module.ts", import.meta.url), "utf8");
  const env = readFileSync(new URL("../services/control-plane/.env.example", import.meta.url), "utf8");
  assert.match(moduleSource, /provide: AgentSupplyChain, useFactory: createAgentSupplyChain/);
  assert.match(client, /DEVILUDO_AGENT_SUPPLY_CHAIN_TLS_KEY_FILE/);
  assert.match(client, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/);
  assert.match(client, /rejectUnauthorized: true/);
  assert.match(client, /minVersion: "TLSv1\.3"/);
  assert.match(client, /\/v1\/agent-versions\/validate/);
  assert.match(client, /\/v1\/agent-installations\/build/);
  assert.match(client, /\/v1\/agent-installations\/rollout/);
  assert.match(client, /sha256Canonical\(core\) !== body\.buildReceiptDigest/);
  assert.match(client, /body\.binaryDigest !== this\.#binaryDigest/);
  assert.match(service, /CALLER_ATTESTATION_FORBIDDEN/);
  assert.match(service, /CALLER_IMAGE_IDENTITY_FORBIDDEN/);
  assert.match(service, /AGENT_VERSION_VALIDATION_RACE/);
  assert.match(service, /INSTALLATION_BUILD_DRIFT/);
  assert.match(service, /ROLLOUT_CONFIGURATION_RACE/);
  assert.match(service, /AgentSupplyChainPolicyFailure/);
  assert.match(service, /AGENT_INSTALLATION_QUARANTINED/);
  assert.match(service, /restoreProfilesToRollback/);
  assert.match(env, /DEVILUDO_AGENT_SUPPLY_CHAIN_TIMEOUT_SECONDS=600/);
  assert.doesNotMatch(env, /PRIVATE KEY|BEGIN CERTIFICATE|@latest/);
  assert.equal(packageJson.scripts["start:agent-supply-chain"], observedServiceCommand("agent-supply-chain"));
  assert.match(packageJson.scripts["test:services"], /npm run test:agent-supply-chain/);
});

test("isolated Agent supply-chain Broker persists and fences fixed native execution", () => {
  const migration = readFileSync(new URL("../infra/postgres/027_agent_supply_chain_operations.sql", import.meta.url), "utf8");
  const ingress = readFileSync(new URL("../services/agent-supply-chain/src/ingress-http.ts", import.meta.url), "utf8");
  const native = readFileSync(new URL("../services/agent-supply-chain/src/locked-native-executor.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("../services/agent-supply-chain/src/postgres-operations.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../services/agent-supply-chain/src/run-service.ts", import.meta.url), "utf8");
  const request = readFileSync(new URL("../services/agent-supply-chain/src/request-contract.ts", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE deviludo\.agent_supply_chain_operations/);
  assert.match(migration, /agent supply-chain operation binding is immutable/);
  assert.match(migration, /completed agent supply-chain operation is immutable/);
  assert.match(migration, /agent_supply_chain_operation_no_delete/);
  assert.match(store, /FOR UPDATE/);
  assert.match(store, /claim_token = \$2::uuid/);
  assert.match(store, /claim_expires_at > \$5::timestamptz/);
  assert.match(ingress, /requestCert: true/);
  assert.match(ingress, /rejectUnauthorized: true/);
  assert.match(ingress, /minVersion: "TLSv1\.3"/);
  assert.match(native, /shell: false/);
  assert.match(native, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/);
  assert.match(native, /DISABLE_UPDATES: "1"/);
  assert.match(native, /TERMINAL_POLICY_EXIT_CODE = 42/);
  assert.match(ingress, /AGENT_SUPPLY_CHAIN_POLICY_REJECTED/);
  assert.match(request, /deviludo\.agent-supply-chain-terminal-failure\.v1/);
  assert.match(request, /sha256Canonical\(core\) !== body\.failureReceiptDigest/);
  assert.doesNotMatch(native, /curl\s*\||npm install|@latest|dangerously-skip-permissions|--yolo/);
  assert.match(runtime, /NODE_ENV !== "production"/);
  assert.match(runtime, /DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_EXECUTABLE_DIGEST/);
  assert.match(request, /registry\.npmjs\.org\/\@anthropic-ai\/claude-code/);
  assert.match(request, /registry\.npmjs\.org\/\@openai\/codex/);
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
