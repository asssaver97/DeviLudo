import assert from "node:assert/strict";
import test from "node:test";
import { AdminService } from "../src/admin.service";
import { InMemoryAdminStore, recordAdminAudit } from "../src/admin.store";
import { DevelopmentAgentSupplyChain } from "../src/agent-supply-chain";
import type { AgentUsageSummary, RequestActor } from "../src/contracts";
import { InferenceRequestReconciler } from "../src/inference-reconciliation";
import { InferenceGatewayProviderProbe } from "../src/provider-probe";
import { ProcessIsolatedSecretVault } from "../src/secret-vault";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "66666666-6666-4666-8666-666666666666";

test("Agent health projects tenant-isolated configuration diffs and fails closed when usage telemetry is unavailable", async () => {
  const store = new InMemoryAdminStore();
  await store.mutate((state) => {
    recordAdminAudit(state, {
      action: "AGENT_DEFAULT_UPDATED", resource: `tenant:${tenantA}`, role: "TenantAdmin",
      actorId: "tenant-a-admin", tenantId: tenantA, projectId: null, requestId: "request-a",
      metadata: { previousProfileRevisionId: "profile-a-r1", profileRevisionId: "profile-a-r2" },
    });
    recordAdminAudit(state, {
      action: "AGENT_DEFAULT_UPDATED", resource: `tenant:${tenantB}`, role: "TenantAdmin",
      actorId: "tenant-b-admin", tenantId: tenantB, projectId: null, requestId: "request-b",
      metadata: { previousProfileRevisionId: "profile-b-r1", profileRevisionId: "profile-b-r2" },
    });
  });
  const health = await service(store).health(actor(tenantA)) as {
    status: string;
    usage: AgentUsageSummary;
    configurationDiffs: Array<{ resource: string; changes: Array<{ before: unknown; after: unknown }> }>;
    alerts: Array<{ code: string }>;
  };
  assert.equal(health.status, "DEGRADED");
  assert.equal(health.usage.available, false);
  assert.deepEqual(health.configurationDiffs.map((item) => item.resource), [`tenant:${tenantA}`]);
  assert.deepEqual(health.configurationDiffs[0]?.changes[0], {
    field: "profileRevisionId", before: "profile-a-r1", after: "profile-a-r2",
  });
  assert.equal(health.alerts.some((alert) => alert.code === "INFERENCE_USAGE_TELEMETRY_UNAVAILABLE"), true);
});

test("Agent health exposes authoritative immutable usage totals without raising a telemetry alert", async () => {
  const store = new class extends InMemoryAdminStore {
    override async readUsage(): Promise<AgentUsageSummary> {
      return Object.freeze({
        available: true,
        source: "inference_usage_events",
        windowStartedAt: "2026-07-21T00:00:00.000Z",
        totals: Object.freeze({ requests: 1, inputTokens: 120, outputTokens: 30, costUsd: 0.00048 }),
        records: Object.freeze([Object.freeze({
          requestId: "44444444-4444-4444-8444-444444444444",
          tenantId: tenantA,
          projectId: "22222222-2222-4222-8222-222222222222",
          runId: "33333333-3333-4333-8333-333333333333",
          providerRevisionId: "provider-platform-claude-r1",
          credentialVersionId: "credential-platform-claude-v1",
          model: "claude-sonnet-4-6-20250514",
          inputTokens: 120,
          outputTokens: 30,
          costUsd: 0.00048,
          recordedAt: "2026-07-21T23:00:00.000Z",
        })]),
      });
    }
  }();
  const health = await service(store).health(actor(null)) as {
    status: string;
    usage: AgentUsageSummary;
    alerts: Array<{ code: string }>;
  };
  assert.equal(health.status, "HEALTHY");
  assert.equal(health.usage.totals.costUsd, 0.00048);
  assert.equal(health.usage.records[0]?.credentialVersionId, "credential-platform-claude-v1");
  assert.equal(health.alerts.some((alert) => alert.code === "INFERENCE_USAGE_TELEMETRY_UNAVAILABLE"), false);
});

function actor(tenantId: string | null): RequestActor {
  return {
    role: "Auditor", actorId: "auditor@example.com", tenantId, projectId: null,
    requestId: "operational-health-request", mutation: undefined,
  };
}

function service(store: InMemoryAdminStore): AdminService {
  return new AdminService(
    store,
    new ProcessIsolatedSecretVault(),
    new InferenceGatewayProviderProbe(),
    new DevelopmentAgentSupplyChain(),
    new class extends InferenceRequestReconciler {
      async lookup() { return null; }
      async reconcile(): Promise<never> { throw new Error("not used"); }
    }(),
  );
}
