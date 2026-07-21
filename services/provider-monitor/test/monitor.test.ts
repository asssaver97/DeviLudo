import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";
import type { PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import {
  parseProviderRecoveryRequest,
  providerRecoveryOperationKey,
  providerRecoveryRequestDigest,
  type ProviderRecoveryReceipt,
  type ProviderRecoveryRequest,
} from "../src/contracts";
import { createProviderMonitorHandler } from "../src/ingress-http";
import { PostgresProviderRecoveryStore } from "../src/postgres-store";
import {
  ProviderRecoveryConflict,
  ProviderRecoveryService,
  type ProviderRecoveryClaim,
  type ProviderRecoveryStore,
} from "../src/service";
import { ProviderRecoveryWorker } from "../src/worker";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const outboxId = "55555555-5555-4555-8555-555555555555";
const claimToken = "66666666-6666-4666-8666-666666666666";
const signalId = "provider-recovery-77777777-7777-4777-8777-777777777777";
const workflowId = "delivery-22222222-2222-4222-8222-222222222222";
const scheduler = "spiffe://deviludo.internal/scheduler/provider-recovery";
const providerId = "provider-claude-r1";
const model = "claude-sonnet-4-20250514";
const probedAt = "2030-01-01T00:00:00.000Z";
const checks = Object.freeze({ authentication: "PASS" as const, modelExistence: "PASS" as const });

function request(overrides: Partial<ProviderRecoveryRequest> = {}): ProviderRecoveryRequest {
  const identity = { tenantId: overrides.tenantId ?? tenantId, projectId: overrides.projectId ?? projectId,
    actionId: overrides.actionId ?? actionId };
  return parseProviderRecoveryRequest({ schemaVersion: "deviludo.provider-recovery-check.v1",
    operationKey: overrides.operationKey ?? providerRecoveryOperationKey(identity), ...identity, ...overrides });
}
function delivery(replayed = false): WorkflowActionCompletionReceipt {
  return Object.freeze({ actionId, outboxId, workflowId, signalId, signalDigest: "b".repeat(64),
    state: "PENDING_DELIVERY", replayed });
}

test("monitor probes the store-derived Provider and emits one exact recovery signal", async () => {
  const input = request(); const claim = claimFor(input); const completed: unknown[] = [];
  const store = memoryStore({ claim });
  const service = new ProviderRecoveryService(store, {
    async run(provider) { assert.equal(provider.id, providerId); assert.equal(provider.agent, "claude-code"); return checks; },
  }, { async complete(value) { completed.push(value); return delivery(); } }, () => new Date(probedAt));
  const receipt = await service.check(input, scheduler);
  assert.equal(receipt.providerRevisionId, providerId);
  assert.equal(store.completed, 1); assert.equal(store.released, 0);
  assert.deepEqual(completed, [{ tenantId, projectId, workflowId, actionId,
    source: "PROVIDER_MONITOR", sourceReceiptId: input.operationKey,
    signal: { signalId, type: "PROVIDER_RESTORED", providerRevisionId: providerId } }]);
});

test("failed probe keeps the action waiting and defers its durable claim", async () => {
  const input = request(); const store = memoryStore({ claim: claimFor(input) }); let completions = 0;
  const service = new ProviderRecoveryService(store, { async run() { throw new Error("offline"); } },
    { async complete() { completions += 1; return delivery(); } });
  await assert.rejects(service.check(input, scheduler), /offline/);
  assert.equal(store.deferred, 1); assert.equal(store.released, 0);
  assert.equal(store.completed, 0); assert.equal(completions, 0);
});

test("completed replay never probes or sends another workflow signal", async () => {
  const input = request(); let probes = 0; let completions = 0;
  const service = new ProviderRecoveryService(memoryStore({ completed: receiptFor(input, delivery()) }),
    { async run() { probes += 1; return checks; } },
    { async complete() { completions += 1; return delivery(); } });
  const replay = await service.check(input, scheduler);
  assert.equal(replay.replayed, true); assert.equal(probes, 0); assert.equal(completions, 0);
});

test("request cannot supply Agent, model, endpoint, credential or Provider authority", () => {
  for (const field of ["agent", "model", "baseUrl", "credentialVersionId", "providerRevisionId"]) {
    assert.throws(() => parseProviderRecoveryRequest({ ...request(), [field]: "attacker-value" }), /invalid/i);
  }
  assert.throws(() => parseProviderRecoveryRequest({ ...request(), operationKey: "a".repeat(64) }), /invalid/i);
});

test("automatic worker scans only signed assigned tenants and recovers due actions", async () => {
  const secondTenant = "88888888-8888-4888-8888-888888888888";
  const calls: string[] = [];
  const worker = new ProviderRecoveryWorker({
    async listDue(selectedTenant, limit) {
      calls.push(`scan:${selectedTenant}:${limit}`);
      return selectedTenant === tenantId ? [request()] : [];
    },
  }, {
    async check(value, subject) {
      const input = parseProviderRecoveryRequest(value);
      calls.push(`check:${input.actionId}:${subject}`);
      return receiptFor(input, delivery());
    },
  }, {
    async listTenantIds(destination) {
      assert.equal(destination, "control-plane");
      return [tenantId, secondTenant];
    },
  }, scheduler, { perTenantLimit: 7 });
  assert.deepEqual(await worker.runCycle(), { attempted: 1, recovered: 1 });
  assert.deepEqual(calls, [
    `scan:${tenantId}:7`, `check:${actionId}:${scheduler}`, `scan:${secondTenant}:7`,
  ]);
});

test("automatic worker rejects unordered or cross-tenant assignment results", async () => {
  const secondTenant = "88888888-8888-4888-8888-888888888888";
  const unordered = new ProviderRecoveryWorker({ async listDue() { return []; } },
    { async check() { throw new Error("unreachable"); } },
    { async listTenantIds() { return [secondTenant, tenantId]; } }, scheduler);
  await assert.rejects(unordered.runCycle(), /assignment is invalid/);

  const drift = new ProviderRecoveryWorker({ async listDue() { return [request()]; } },
    { async check() { throw new Error("unreachable"); } },
    { async listTenantIds() { return [secondTenant]; } }, scheduler);
  await assert.rejects(drift.runCycle(), /candidate set is invalid/);
});

test("PostgreSQL store derives current authority under RLS and persists a digest-only receipt", async () => {
  const client = new RecoverySqlFixture();
  const store = new PostgresProviderRecoveryStore({ async connect() { return client; } },
    { claimId: () => claimToken, signalId: () => signalId });
  const outcome = await store.begin({ request: request(), schedulerSubject: scheduler });
  assert.equal(outcome.kind, "CLAIMED");
  assert.ok(client.sql.some((value) => value.includes("SELECT set_config('app.tenant_id'")));
  const authority = client.sql.find((value) => value.includes("FROM deviludo.workflow_control_actions action")) ?? "";
  assert.match(authority, /JOIN deviludo\.agent_runs run/);
  assert.match(authority, /LEFT JOIN deviludo\.agent_run_provider_failovers failover/);
  assert.match(authority, /provider\.provider_revision_id = action\.binding->>'providerRevisionId'/);
  assert.match(authority, /FOR UPDATE OF action, run, execution/);
  if (outcome.kind !== "CLAIMED") throw new Error("claim missing");
  assert.equal(outcome.claim.provider.id, providerId);
  const result = await store.complete({ claim: outcome.claim, probeDigest: "c".repeat(64), probedAt, delivery: delivery() });
  assert.equal(result.probeDigest, "c".repeat(64));
  const update = client.sql.find((value) => value.includes("probe_digest = $5")) ?? "";
  assert.doesNotMatch(update, /base_url|models|credential_version_id|raw_response|api_key/i);
  const replay = await store.begin({ request: request(), schedulerSubject: scheduler });
  assert.equal(replay.kind, "COMPLETED");
});

test("PostgreSQL due scan is bounded, RLS-scoped and derives the canonical operation key", async () => {
  const client = new RecoverySqlFixture();
  const store = new PostgresProviderRecoveryStore({ async connect() { return client; } });
  const due = await store.listDue(tenantId, 9);
  assert.deepEqual(due, [request()]);
  const query = client.sql.find((value) => value.includes("AS candidate_project_id")) ?? "";
  assert.match(query, /action\.tenant_id = \$1::uuid/);
  assert.match(query, /recovery\.next_probe_at <= now\(\)/);
  assert.match(query, /LIMIT \$2/);
  assert.ok(client.sql.some((value) => value.includes("SELECT set_config('app.tenant_id'")));
});

test("failed PostgreSQL claims use bounded persistent backoff", async () => {
  const client = new RecoverySqlFixture();
  const store = new PostgresProviderRecoveryStore({ async connect() { return client; } },
    { claimId: () => claimToken, signalId: () => signalId });
  const outcome = await store.begin({ request: request(), schedulerSubject: scheduler });
  if (outcome.kind !== "CLAIMED") throw new Error("claim missing");
  await store.defer(outcome.claim, "PROVIDER_PROBE_FAILED");
  const update = client.sql.find((value) => value.includes("make_interval")) ?? "";
  assert.match(update, /LEAST\(\s*300/);
  assert.match(update, /attempt_count - 1/);
  assert.match(update, /last_failure_code = \$5/);
});

test("another allow-listed scheduler can safely take over the canonical released action", async () => {
  const client = new RecoverySqlFixture();
  const store = new PostgresProviderRecoveryStore({ async connect() { return client; } },
    { claimId: () => claimToken, signalId: () => signalId });
  const first = await store.begin({ request: request(), schedulerSubject: scheduler });
  if (first.kind !== "CLAIMED") throw new Error("first claim missing");
  await store.release(first.claim);
  const secondScheduler = "spiffe://deviludo.internal/scheduler/provider-recovery-backup";
  const second = await store.begin({ request: request(), schedulerSubject: secondScheduler });
  assert.equal(second.kind, "CLAIMED");
  if (second.kind !== "CLAIMED") throw new Error("second claim missing");
  assert.equal(second.claim.schedulerSubject, scheduler);
  assert.equal(second.claim.request.operationKey, first.claim.request.operationKey);
});

test("same-Agent project fallback is accepted, while cross-Agent drift is rejected", async () => {
  const fallbackClient = new RecoverySqlFixture({ fallback: true });
  const fallbackStore = new PostgresProviderRecoveryStore({ async connect() { return fallbackClient; } },
    { claimId: () => claimToken, signalId: () => signalId });
  const accepted = await fallbackStore.begin({ request: request(), schedulerSubject: scheduler });
  assert.equal(accepted.kind, "CLAIMED");
  if (accepted.kind !== "CLAIMED") throw new Error("fallback missing");
  assert.equal(accepted.claim.provider.id, "provider-claude-fallback-r1");
  assert.equal(accepted.claim.provider.agent, "claude-code");

  const crossAgent = new RecoverySqlFixture({ providerAgent: "codex-cli" });
  const rejectedStore = new PostgresProviderRecoveryStore({ async connect() { return crossAgent; } },
    { claimId: () => claimToken, signalId: () => signalId });
  await assert.rejects(rejectedStore.begin({ request: request(), schedulerSubject: scheduler }),
    (error) => error instanceof ProviderRecoveryConflict && error.code === "PROVIDER_RECOVERY_CONFLICT");
});

test("authority rows cannot cross the request tenant or project even if a database adapter drifts", async () => {
  for (const overrides of [
    { tenantId: "88888888-8888-4888-8888-888888888888" },
    { projectId: "99999999-9999-4999-8999-999999999999" },
  ]) {
    const client = new RecoverySqlFixture();
    const store = new PostgresProviderRecoveryStore({ async connect() { return client; } },
      { claimId: () => claimToken, signalId: () => signalId });
    await assert.rejects(store.begin({ request: request(overrides), schedulerSubject: scheduler }),
      (error) => error instanceof ProviderRecoveryConflict && error.code === "PROVIDER_RECOVERY_CONFLICT");
  }
});

test("mTLS ingress accepts only allow-listed schedulers", async () => {
  let checksRun = 0;
  const handler = createProviderMonitorHandler({
    allowedSchedulerSpiffeIds: new Set([scheduler]),
    extractIdentity(socket) { return { spiffeId: String(socket), certificateFingerprint: "d".repeat(64),
      certificateSerial: "01", certificateNotAfter: "2031-01-01T00:00:00.000Z" }; },
    service: { async check(value, subject) { checksRun += 1; assert.equal(subject, scheduler);
      return receiptFor(parseProviderRecoveryRequest(value), delivery()); }, async probe() {} },
  });
  const accepted = await handler({ method: "POST", path: "/v1/provider-recovery-checks",
    headers: { "content-type": "application/json" }, socket: scheduler, rawBody: JSON.stringify(request()) });
  assert.equal(accepted.status, 201);
  const forbidden = await handler({ method: "POST", path: "/v1/provider-recovery-checks",
    headers: { "content-type": "application/json" }, socket: "spiffe://evil.invalid/scheduler", rawBody: JSON.stringify(request()) });
  assert.equal(forbidden.status, 403); assert.equal(checksRun, 1);
});

function claimFor(input: ProviderRecoveryRequest): ProviderRecoveryClaim {
  return Object.freeze({ claimToken, requestDigest: providerRecoveryRequestDigest(input), request: input,
    schedulerSubject: scheduler, workflowId, runId, signalId, provider: Object.freeze({
      id: providerId, agent: "claude-code", protocol: "anthropic-messages",
      baseUrl: "https://provider.example/v1", approvedPorts: Object.freeze([443]), authentication: "x-api-key",
      models: { primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model },
      credentialVersionId: "credential-claude-v1",
    }) });
}
function receiptFor(input: ProviderRecoveryRequest, result: WorkflowActionCompletionReceipt): ProviderRecoveryReceipt {
  return Object.freeze({ schemaVersion: "deviludo.provider-recovery-receipt.v1", operationKey: input.operationKey,
    actionId, workflowId, runId, providerRevisionId: providerId, probeDigest: "c".repeat(64), probedAt,
    schedulerSubject: scheduler, delivery: result, replayed: result.replayed });
}
function memoryStore(options: { claim?: ProviderRecoveryClaim; completed?: ProviderRecoveryReceipt }) {
  const store: ProviderRecoveryStore & { completed: number; deferred: number; released: number } = {
    completed: 0, deferred: 0, released: 0,
    async listDue() { return []; },
    async begin() { return options.completed ? { kind: "COMPLETED", receipt: options.completed }
      : { kind: "CLAIMED", claim: options.claim! }; },
    async complete(input) { this.completed += 1; return receiptFor(input.claim.request, input.delivery); },
    async defer() { this.deferred += 1; },
    async release() { this.released += 1; }, async probe() {},
  }; return store;
}

class RecoverySqlFixture implements PostgresWorkflowClient {
  readonly sql: string[] = []; row: Record<string, unknown> | null = null;
  constructor(private readonly options: { fallback?: boolean; providerAgent?: string } = {}) {}
  async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.sql.push(text);
    if (text.includes("AS candidate_project_id")) return rows([{
      candidate_project_id: projectId, candidate_action_id: actionId,
    } as unknown as Row]);
    if (text.includes("FROM deviludo.provider_recovery_checks")) return rows(this.row ? [this.row as Row] : []);
    if (text.includes("FROM deviludo.workflow_control_actions action")) return rows([this.authority() as unknown as Row]);
    if (text.includes("INSERT INTO deviludo.provider_recovery_checks")) {
      this.row = { operation_key: values[0], request_digest: values[1], tenant_id: values[2], project_id: values[3],
        action_id: values[4], workflow_id: values[5], run_id: values[6], provider_revision_id: values[7],
        scheduler_subject: values[8], signal_id: values[9], state: "PENDING", claim_token: values[10],
        claim_active: true, retry_due: true, attempt_count: 1, receipt: null }; return rows([], 1);
    }
    if (text.includes("SET state = 'COMPLETED'")) {
      this.row = { ...this.row, state: "COMPLETED", claim_token: null, claim_active: false,
        receipt: JSON.parse(String(values[7])) as unknown }; return rows([], 1);
    }
    if (text.includes("attempt_count = attempt_count + 1")) {
      this.row = { ...this.row, claim_token: values[3], claim_active: true, retry_due: true,
        attempt_count: Number(this.row?.attempt_count ?? 0) + 1 };
      return rows([], 1);
    }
    if (text.includes("SET claim_token = NULL")) {
      this.row = { ...this.row, claim_token: null, claim_active: false,
        retry_due: !text.includes("make_interval") };
      return rows([], 1);
    }
    return rows([]);
  }
  release() {}
  private authority() {
    const fallbackId = "provider-claude-fallback-r1";
    const selectedProvider = this.options.fallback ? fallbackId : providerId;
    const providerAgent = this.options.providerAgent ?? "claude-code";
    return { tenant_id: tenantId, project_id: projectId, action_id: actionId, workflow_id: workflowId,
      action_operation: "WAIT_FOR_PROVIDER", action_status: "WAITING",
      action_binding: { state: "WAITING_PROVIDER", lockedRunConfigurationId: runId, providerRevisionId: selectedProvider },
      run_id: runId, run_state: "WAITING_PROVIDER", resolution_digest: "e".repeat(64),
      configuration_lock: { resolutionDigest: "e".repeat(64), agent: "claude-code", profileRevisionId: "profile-claude-r1",
        providerRevisionId: providerId, credentialVersionId: "credential-claude-v1",
        modelRoles: { primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model },
        profileSource: this.options.fallback ? `project:${projectId}` : "platform:global",
        fallback: this.options.fallback ? { agent: "claude-code", profileRevisionId: "profile-claude-fallback-r1",
          providerRevisionId: fallbackId, credentialVersionId: "credential-claude-fallback-v1",
          modelRoles: { primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model } } : null },
      authorization_profile_revision_id: "profile-claude-r1", authorization_provider_revision_id: providerId,
      authorization_credential_version_id: "credential-claude-v1", authorization_state: "ACTIVE",
      authorization_expires_at: "2099-01-01T00:00:00.000Z",
      failover_from_profile_revision_id: this.options.fallback ? "profile-claude-r1" : null,
      failover_from_provider_revision_id: this.options.fallback ? providerId : null,
      failover_to_profile_revision_id: this.options.fallback ? "profile-claude-fallback-r1" : null,
      failover_to_provider_revision_id: this.options.fallback ? fallbackId : null,
      failover_to_credential_version_id: this.options.fallback ? "credential-claude-fallback-v1" : null,
      failover_authorization_expires_at: this.options.fallback ? "2099-01-01T00:00:00.000Z" : null,
      operation_state: "WAITING_PROVIDER", operation_workflow_id: workflowId,
      effective_authorization_active: true, active_claims: "0", provider_revision_id: selectedProvider,
      provider_state: "ACTIVE", provider_agent: providerAgent,
      provider_protocol: providerAgent === "codex-cli" ? "openai-responses" : "anthropic-messages",
      provider_base_url: "https://provider.example/v1", provider_approved_ports: [443],
      provider_authentication: providerAgent === "codex-cli" ? "bearer" : "x-api-key",
      provider_models: { primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model },
      provider_credential_version_id: this.options.fallback ? "credential-claude-fallback-v1" : "credential-claude-v1" };
  }
}
function rows<Row extends Record<string, unknown>>(values: readonly Row[], rowCount = values.length) { return { rows: values, rowCount }; }
