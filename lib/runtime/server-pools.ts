export const SERVER_POOL_KINDS = [
  "WEB",
  "CORE",
  "E2E_LINUX",
  "E2E_WINDOWS",
  "E2E_MACOS",
] as const;

export type ServerPoolKind = typeof SERVER_POOL_KINDS[number];
export type ServerOperatingSystem = "linux" | "windows" | "macos";
export type PoolReadiness = "READY" | "DEGRADED" | "NOT_READY" | "ON_DEMAND_READY";
export type ServerNodeState = "PROVISIONING" | "ACTIVE" | "DRAINING" | "DISABLED" | "REIMAGING";

export type ServerPoolDefinition = Readonly<{
  kind: ServerPoolKind;
  operatingSystem: ServerOperatingSystem;
  minimumNodes: number;
  maximumNodes: number;
  desiredNodes: number;
  capabilities: readonly string[];
  publicIngress: boolean;
}>;

export const SERVER_POOL_DEFINITIONS: Readonly<Record<ServerPoolKind, ServerPoolDefinition>> = Object.freeze({
  WEB: Object.freeze({
    kind: "WEB",
    operatingSystem: "linux",
    minimumNodes: 1,
    maximumNodes: 1,
    desiredNodes: 1,
    capabilities: Object.freeze(["CUSTOMER_WEB", "STREAMING_BFF"]),
    publicIngress: true,
  }),
  CORE: Object.freeze({
    kind: "CORE",
    operatingSystem: "linux",
    minimumNodes: 1,
    maximumNodes: 1,
    desiredNodes: 1,
    capabilities: Object.freeze([
      "BUSINESS_API",
      "WORKFLOW_SCHEDULER",
      "AGENT_GENERATION",
      "ARTIFACT_BUILD",
      "STEAM_PUBLISH",
    ]),
    publicIngress: false,
  }),
  E2E_LINUX: Object.freeze({
    kind: "E2E_LINUX",
    operatingSystem: "linux",
    minimumNodes: 1,
    maximumNodes: 1,
    desiredNodes: 1,
    capabilities: Object.freeze(["E2E_TEST"]),
    publicIngress: false,
  }),
  E2E_WINDOWS: Object.freeze({
    kind: "E2E_WINDOWS",
    operatingSystem: "windows",
    minimumNodes: 1,
    maximumNodes: 1,
    desiredNodes: 1,
    capabilities: Object.freeze(["E2E_TEST"]),
    publicIngress: false,
  }),
  E2E_MACOS: Object.freeze({
    kind: "E2E_MACOS",
    operatingSystem: "macos",
    minimumNodes: 0,
    maximumNodes: 1,
    desiredNodes: 0,
    capabilities: Object.freeze(["E2E_TEST"]),
    publicIngress: false,
  }),
});

export type ServerPoolRecord = ServerPoolDefinition & Readonly<{
  readiness: PoolReadiness;
  activeNodes: number;
  drainingNodes: number;
}>;

export type ServerNodeRecord = Readonly<{
  id: string;
  poolKind: ServerPoolKind;
  operatingSystem: ServerOperatingSystem;
  state: ServerNodeState;
  capabilities: readonly string[];
  isolationGeneration: number;
  currentWorkspaceId: string | null;
  lastHeartbeatAt: string | null;
  lastReimageProofAt: string | null;
}>;

export function isServerPoolKind(value: unknown): value is ServerPoolKind {
  return typeof value === "string" && (SERVER_POOL_KINDS as readonly string[]).includes(value);
}

export function expectedOperatingSystem(poolKind: ServerPoolKind): ServerOperatingSystem {
  return SERVER_POOL_DEFINITIONS[poolKind].operatingSystem;
}

export function assertPoolOperatingSystem(poolKind: ServerPoolKind, operatingSystem: ServerOperatingSystem): void {
  if (expectedOperatingSystem(poolKind) !== operatingSystem) {
    throw new Error(`${poolKind} requires ${expectedOperatingSystem(poolKind)}`);
  }
}

export function poolReadiness(
  poolKind: ServerPoolKind,
  activeNodes: number,
  drainingNodes = 0,
): PoolReadiness {
  const definition = SERVER_POOL_DEFINITIONS[poolKind];
  if (![activeNodes, drainingNodes].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Pool node counts must be non-negative integers");
  }
  if (poolKind === "E2E_MACOS" && activeNodes === 0) return "ON_DEMAND_READY";
  if (activeNodes >= definition.minimumNodes) return drainingNodes > 0 ? "DEGRADED" : "READY";
  return activeNodes > 0 ? "DEGRADED" : "NOT_READY";
}

export function fixedPoolRecords(nodes: readonly ServerNodeRecord[]): readonly ServerPoolRecord[] {
  return Object.freeze(SERVER_POOL_KINDS.map(kind => {
    const matching = nodes.filter(node => node.poolKind === kind);
    const activeNodes = matching.filter(node => node.state === "ACTIVE").length;
    const drainingNodes = matching.filter(node => node.state === "DRAINING").length;
    return Object.freeze({
      ...SERVER_POOL_DEFINITIONS[kind],
      activeNodes,
      drainingNodes,
      readiness: poolReadiness(kind, activeNodes, drainingNodes),
    });
  }));
}
