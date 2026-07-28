import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AGENT_RESOURCE_CLASSES,
  MULTITENANT_CAPACITY_POLICY,
  assertAgentResourceClass,
  canAdmitWorkspaceTask,
  capacityScaleDecision,
  e2eQueueBinding,
  e2eGateOrder,
  effectiveQueuePriority,
  fairTenantScanOrder,
  requirementsDialogueScaleDecision,
  runnerSlotLimit,
} from "../lib/runtime/capacity-policy.ts";

test("Agent microVM resource classes are fixed at 2C4G, 4C8G and 8C16G", () => {
  assert.deepEqual(AGENT_RESOURCE_CLASSES, {
    SMALL: { vcpu: 2, memoryMib: 4_096 },
    STANDARD: { vcpu: 4, memoryMib: 8_192 },
    LARGE: { vcpu: 8, memoryMib: 16_384 },
  });
  assert.doesNotThrow(() => assertAgentResourceClass("STANDARD", 4, 8_192));
  assert.throws(() => assertAgentResourceClass("STANDARD", 8, 8_192), /does not match/);
  assert.equal(MULTITENANT_CAPACITY_POLICY.cpuSchedulingRatio, 1.5);
  assert.equal(MULTITENANT_CAPACITY_POLICY.memorySchedulingRatio, 1);
  assert.equal(MULTITENANT_CAPACITY_POLICY.targetStandardEquivalentConcurrency, 28);
});

test("fair scheduling caps each workspace at two Agent tasks and one exclusive E2E task", () => {
  assert.equal(canAdmitWorkspaceTask({ agentTasks: 1, exclusiveE2eTasks: 1 }, "AGENT"), true);
  assert.equal(canAdmitWorkspaceTask({ agentTasks: 2, exclusiveE2eTasks: 0 }, "AGENT"), false);
  assert.equal(canAdmitWorkspaceTask({ agentTasks: 0, exclusiveE2eTasks: 1 }, "EXCLUSIVE_E2E"), false);
});

test("Linux fast gate precedes the complete selected release matrix", () => {
  assert.deepEqual(e2eGateOrder(["macos", "windows"]), ["linux-fast", "windows-full", "macos-full"]);
  assert.deepEqual(e2eGateOrder(["linux", "windows", "macos"]), ["linux-fast", "linux-full", "windows-full", "macos-full"]);
});

test("headless runners use two slots and user-visible hardware work stays exclusive", () => {
  for (const platform of ["linux", "windows", "macos"]) {
    assert.equal(runnerSlotLimit(platform, "HEADLESS"), 2);
    assert.equal(runnerSlotLimit(platform, "VISUAL"), 1);
    assert.equal(runnerSlotLimit(platform, "GPU"), 1);
    assert.equal(runnerSlotLimit(platform, "AUDIO"), 1);
    assert.equal(runnerSlotLimit(platform, "STEAM_INSTALL"), 1);
  }
});

test("shared test queue uses release priority, aging, shortest-job backfill and round-robin tenants", () => {
  assert.deepEqual(e2eQueueBinding("CANDIDATE", 2), {
    lane: "INTERACTIVE", basePriority: 200, estimatedDurationSeconds: 1_500, workload: "VISUAL",
  });
  assert.deepEqual(e2eQueueBinding("MAIN_RELEASE_GATE", 3), {
    lane: "RELEASE", basePriority: 300, estimatedDurationSeconds: 3_000, workload: "VISUAL",
  });
  assert.deepEqual(e2eQueueBinding("STEAM_CLEAN_INSTALL", 1), {
    lane: "RELEASE", basePriority: 300, estimatedDurationSeconds: 3_300, workload: "STEAM_INSTALL",
  });
  assert.equal(effectiveQueuePriority({
    lane: "BACKGROUND", queuedAt: "2030-01-01T00:00:00.000Z", now: "2030-01-01T04:10:00.000Z",
  }), 350);
  assert.deepEqual(fairTenantScanOrder(["a", "b", "c"], "b"), ["c", "a", "b"]);
  assert.equal(MULTITENANT_CAPACITY_POLICY.testQueue.schedulingHorizonHours, 24);
  assert.equal(MULTITENANT_CAPACITY_POLICY.testQueue.targetBusyFraction.linux, .96);
});

test("capacity autoscaling keeps high test utilization while preserving queue SLOs", () => {
  assert.deepEqual(capacityScaleDecision({ cpuUtilization: .91, memoryUtilization: .89, macUtilization: .89, agentQueueP95Seconds: 60, linuxWindowsQueueP95Seconds: 300, macQueueP95Seconds: 600 }), { scaleOut: false, reasons: [] });
  assert.deepEqual(capacityScaleDecision({ cpuUtilization: .92, memoryUtilization: .90, macUtilization: .90, agentQueueP95Seconds: 61, linuxWindowsQueueP95Seconds: 301, macQueueP95Seconds: 601 }), { scaleOut: true, reasons: ["CPU", "MEMORY", "MAC", "AGENT_QUEUE_SLO", "LINUX_WINDOWS_QUEUE_SLO", "MAC_QUEUE_SLO"] });
});

test("requirements dialogue has an isolated warm reserve and stricter latency autoscaling", () => {
  assert.equal(MULTITENANT_CAPACITY_POLICY.requirementsDialogue.isolatedFromAgentAndE2ePools, true);
  assert.equal(MULTITENANT_CAPACITY_POLICY.requirementsDialogue.minimumReplicasPerService, 3);
  assert.deepEqual(requirementsDialogueScaleDecision({
    readyReplicas: 3, inflightUtilization: .54, admissionQueueP95Milliseconds: 250, modelTurnP95Milliseconds: 8_000,
  }), { scaleOut: false, reasons: [] });
  assert.deepEqual(requirementsDialogueScaleDecision({
    readyReplicas: 2, inflightUtilization: .55, admissionQueueP95Milliseconds: 251, modelTurnP95Milliseconds: 8_001,
  }), { scaleOut: true, reasons: ["RESERVED_REPLICAS", "INFLIGHT_HEADROOM", "ADMISSION_QUEUE_SLO", "MODEL_TURN_SLO"] });
});

test("PostgreSQL serializes workspace fairness and physical Runner slot admission", async () => {
  const sql = await readFile(new URL("../infra/postgres/067_multitenant_capacity_guards.sql", import.meta.url), "utf8");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /active_count >= 2/);
  assert.match(sql, /active_count >= 1/);
  assert.match(sql, /requested_class='HEADLESS'/);
  assert.match(sql, /runner_workload_class IN \('HEADLESS','VISUAL','GPU','AUDIO','STEAM_INSTALL'\)/);
});

test("PostgreSQL derives immutable shared queue priority and leases with aging/backfill", async () => {
  const migration = await readFile(new URL("../infra/postgres/068_shared_e2e_queue.sql", import.meta.url), "utf8");
  const ingress = await readFile(new URL("../services/runner-control/src/postgres-ingress.ts", import.meta.url), "utf8");
  assert.match(migration, /queue_lane IN \('RELEASE','INTERACTIVE','BACKGROUND'\)/);
  assert.match(migration, /derive_e2e_queue_binding/);
  assert.match(migration, /queue binding is immutable/);
  assert.match(ingress, /queue_deadline_at <= \$3::timestamptz/);
  assert.match(ingress, /attempt\.queue_priority/);
  assert.match(ingress, /attempt\.estimated_duration_seconds/);
  assert.match(ingress, /FOR UPDATE OF attempt SKIP LOCKED/);
});
