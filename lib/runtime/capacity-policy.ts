import type { TargetPlatform } from "../domain/types";

export type AgentResourceClass = "SMALL" | "STANDARD" | "LARGE";
export type RunnerWorkload = "HEADLESS" | "VISUAL" | "GPU" | "AUDIO" | "STEAM_INSTALL";
export type TestQueueLane = "RELEASE" | "INTERACTIVE" | "BACKGROUND";
export type E2eAttemptMode = "CANDIDATE" | "MAIN_RELEASE_GATE" | "STEAM_CLEAN_INSTALL";

export const AGENT_RESOURCE_CLASSES = Object.freeze({
  SMALL: Object.freeze({ vcpu: 2, memoryMib: 4_096 }),
  STANDARD: Object.freeze({ vcpu: 4, memoryMib: 8_192 }),
  LARGE: Object.freeze({ vcpu: 8, memoryMib: 16_384 }),
} satisfies Record<AgentResourceClass, Readonly<{ vcpu: number; memoryMib: number }>>);

export const MULTITENANT_CAPACITY_POLICY = Object.freeze({
  revision: 2,
  hostReserve: Object.freeze({ vcpu: 8, memoryMib: 24_576 }),
  cpuSchedulingRatio: 1.5,
  memorySchedulingRatio: 1,
  targetStandardEquivalentConcurrency: 28,
  agentInteractiveReserve: Object.freeze({ minimumSlots: 2, resourceFraction: .20 }),
  workspaceConcurrency: Object.freeze({ agentTasks: 2, exclusiveE2eTasks: 1 }),
  runnerConcurrency: Object.freeze({
    linux: Object.freeze({ HEADLESS: 2, VISUAL: 1, GPU: 1, AUDIO: 1, STEAM_INSTALL: 1 }),
    windows: Object.freeze({ HEADLESS: 2, VISUAL: 1, GPU: 1, AUDIO: 1, STEAM_INSTALL: 1 }),
      macos: Object.freeze({ HEADLESS: 2, VISUAL: 1, GPU: 1, AUDIO: 1, STEAM_INSTALL: 1 }),
  }),
  testQueue: Object.freeze({
    schedulingHorizonHours: 24,
    readyBacklogTargetHours: 24,
    lanePriority: Object.freeze({ RELEASE: 300, INTERACTIVE: 200, BACKGROUND: 100 }),
    agingIntervalSeconds: 60,
    maximumAgingBoost: 250,
    shortestJobBackfillWithinPriority: true,
    targetBusyFraction: Object.freeze({ linux: .96, windows: .96, macos: .94 }),
    productiveUtilizationTarget: Object.freeze({ linux: .90, windows: .90, macos: .85 }),
    maintenanceAndTurnaroundReserve: Object.freeze({ linux: .10, windows: .10, macos: .15 }),
  }),
  requirementsDialogue: Object.freeze({
    isolatedFromAgentAndE2ePools: true,
    minimumReplicasPerService: 3,
    warmSpareReplicas: 1,
    reservedCpuMillicoresPerReplica: 500,
    reservedMemoryMibPerReplica: 512,
    maximumInflightTurnsPerReplica: 24,
    admissionQueueP95Milliseconds: 250,
    modelTurnP95Milliseconds: 8_000,
    scaleOutInflightUtilization: .55,
  }),
  queueSloSeconds: Object.freeze({ agentP95: 60, linuxWindowsP95: 300, macosP95: 600 }),
  scaleOutThresholds: Object.freeze({ cpu: .92, memory: .90, mac: .90 }),
});

export function assertAgentResourceClass(resourceClass: AgentResourceClass, vcpu: number, memoryMib: number): void {
  const expected = AGENT_RESOURCE_CLASSES[resourceClass];
  if (!expected || vcpu !== expected.vcpu || memoryMib !== expected.memoryMib) {
    throw new Error("Agent resource class does not match its fixed CPU and memory shape");
  }
}

export function e2eGateOrder(targetMatrix: readonly TargetPlatform[]): readonly string[] {
  if (!Array.isArray(targetMatrix) || targetMatrix.length < 1 || targetMatrix.length > 3
    || new Set(targetMatrix).size !== targetMatrix.length
    || targetMatrix.some(platform => !(["linux", "windows", "macos"] as string[]).includes(platform))) {
    throw new Error("E2E target matrix is invalid");
  }
  const order: TargetPlatform[] = ["linux", "windows", "macos"];
  return Object.freeze(["linux-fast", ...order.filter(platform => targetMatrix.includes(platform)).map(platform => `${platform}-full`)]);
}

export function runnerSlotLimit(platform: TargetPlatform, workload: RunnerWorkload): number {
  return MULTITENANT_CAPACITY_POLICY.runnerConcurrency[platform][workload];
}

export function e2eQueueBinding(
  mode: E2eAttemptMode,
  targetCount: number,
): Readonly<{
  lane: TestQueueLane;
  basePriority: number;
  estimatedDurationSeconds: number;
  workload: RunnerWorkload;
}> {
  if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 3) {
    throw new Error("E2E queue target count is invalid");
  }
  if (mode === "CANDIDATE") {
    return Object.freeze({
      lane: "INTERACTIVE",
      basePriority: MULTITENANT_CAPACITY_POLICY.testQueue.lanePriority.INTERACTIVE,
      estimatedDurationSeconds: 900 + targetCount * 300,
      workload: "VISUAL",
    });
  }
  if (mode === "MAIN_RELEASE_GATE") {
    return Object.freeze({
      lane: "RELEASE",
      basePriority: MULTITENANT_CAPACITY_POLICY.testQueue.lanePriority.RELEASE,
      estimatedDurationSeconds: 1_200 + targetCount * 600,
      workload: "VISUAL",
    });
  }
  if (mode === "STEAM_CLEAN_INSTALL") {
    return Object.freeze({
      lane: "RELEASE",
      basePriority: MULTITENANT_CAPACITY_POLICY.testQueue.lanePriority.RELEASE,
      estimatedDurationSeconds: 2_400 + targetCount * 900,
      workload: "STEAM_INSTALL",
    });
  }
  throw new Error("E2E attempt mode is invalid");
}

export function effectiveQueuePriority(input: Readonly<{
  lane: TestQueueLane;
  queuedAt: string;
  now: string;
}>): number {
  const basePriority = MULTITENANT_CAPACITY_POLICY.testQueue.lanePriority[input.lane];
  const queuedAt = Date.parse(input.queuedAt);
  const now = Date.parse(input.now);
  if (!basePriority || !Number.isFinite(queuedAt) || !Number.isFinite(now) || now < queuedAt) {
    throw new Error("E2E queue timing is invalid");
  }
  const aging = Math.min(
    MULTITENANT_CAPACITY_POLICY.testQueue.maximumAgingBoost,
    Math.floor((now - queuedAt) / 1_000 / MULTITENANT_CAPACITY_POLICY.testQueue.agingIntervalSeconds),
  );
  return basePriority + aging;
}

export function fairTenantScanOrder(
  tenantIds: readonly string[],
  lastServedTenantId: string | null,
): readonly string[] {
  if (!Array.isArray(tenantIds) || tenantIds.length < 1 || new Set(tenantIds).size !== tenantIds.length) {
    throw new Error("Runner tenant queue is invalid");
  }
  if (lastServedTenantId === null) return Object.freeze([...tenantIds]);
  const previous = tenantIds.indexOf(lastServedTenantId);
  if (previous < 0) return Object.freeze([...tenantIds]);
  const start = (previous + 1) % tenantIds.length;
  return Object.freeze([...tenantIds.slice(start), ...tenantIds.slice(0, start)]);
}

export function canAdmitWorkspaceTask(active: Readonly<{ agentTasks: number; exclusiveE2eTasks: number }>, kind: "AGENT" | "EXCLUSIVE_E2E"): boolean {
  if (!Number.isSafeInteger(active.agentTasks) || active.agentTasks < 0 || !Number.isSafeInteger(active.exclusiveE2eTasks) || active.exclusiveE2eTasks < 0) {
    throw new Error("Workspace concurrency state is invalid");
  }
  return kind === "AGENT"
    ? active.agentTasks < MULTITENANT_CAPACITY_POLICY.workspaceConcurrency.agentTasks
    : active.exclusiveE2eTasks < MULTITENANT_CAPACITY_POLICY.workspaceConcurrency.exclusiveE2eTasks;
}

export function capacityScaleDecision(signal: Readonly<{
  cpuUtilization: number;
  memoryUtilization: number;
  macUtilization: number;
  agentQueueP95Seconds: number;
  linuxWindowsQueueP95Seconds: number;
  macQueueP95Seconds: number;
}>): Readonly<{ scaleOut: boolean; reasons: readonly string[] }> {
  const ratios = [signal.cpuUtilization, signal.memoryUtilization, signal.macUtilization];
  const queues = [signal.agentQueueP95Seconds, signal.linuxWindowsQueueP95Seconds, signal.macQueueP95Seconds];
  if (ratios.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || queues.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Capacity signal is invalid");
  const reasons: string[] = [];
  if (signal.cpuUtilization >= MULTITENANT_CAPACITY_POLICY.scaleOutThresholds.cpu) reasons.push("CPU");
  if (signal.memoryUtilization >= MULTITENANT_CAPACITY_POLICY.scaleOutThresholds.memory) reasons.push("MEMORY");
  if (signal.macUtilization >= MULTITENANT_CAPACITY_POLICY.scaleOutThresholds.mac) reasons.push("MAC");
  if (signal.agentQueueP95Seconds > MULTITENANT_CAPACITY_POLICY.queueSloSeconds.agentP95) reasons.push("AGENT_QUEUE_SLO");
  if (signal.linuxWindowsQueueP95Seconds > MULTITENANT_CAPACITY_POLICY.queueSloSeconds.linuxWindowsP95) reasons.push("LINUX_WINDOWS_QUEUE_SLO");
  if (signal.macQueueP95Seconds > MULTITENANT_CAPACITY_POLICY.queueSloSeconds.macosP95) reasons.push("MAC_QUEUE_SLO");
  return Object.freeze({ scaleOut: reasons.length > 0, reasons: Object.freeze(reasons) });
}

export function requirementsDialogueScaleDecision(signal: Readonly<{
  readyReplicas: number;
  inflightUtilization: number;
  admissionQueueP95Milliseconds: number;
  modelTurnP95Milliseconds: number;
}>): Readonly<{ scaleOut: boolean; reasons: readonly string[] }> {
  if (!Number.isSafeInteger(signal.readyReplicas) || signal.readyReplicas < 0
    || !Number.isFinite(signal.inflightUtilization) || signal.inflightUtilization < 0 || signal.inflightUtilization > 1
    || !Number.isFinite(signal.admissionQueueP95Milliseconds) || signal.admissionQueueP95Milliseconds < 0
    || !Number.isFinite(signal.modelTurnP95Milliseconds) || signal.modelTurnP95Milliseconds < 0) {
    throw new Error("Requirements dialogue capacity signal is invalid");
  }
  const policy = MULTITENANT_CAPACITY_POLICY.requirementsDialogue;
  const reasons: string[] = [];
  if (signal.readyReplicas < policy.minimumReplicasPerService) reasons.push("RESERVED_REPLICAS");
  if (signal.inflightUtilization >= policy.scaleOutInflightUtilization) reasons.push("INFLIGHT_HEADROOM");
  if (signal.admissionQueueP95Milliseconds > policy.admissionQueueP95Milliseconds) reasons.push("ADMISSION_QUEUE_SLO");
  if (signal.modelTurnP95Milliseconds > policy.modelTurnP95Milliseconds) reasons.push("MODEL_TURN_SLO");
  return Object.freeze({ scaleOut: reasons.length > 0, reasons: Object.freeze(reasons) });
}
