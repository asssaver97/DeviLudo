export const CORE_MODULES = Object.freeze([
  Object.freeze({ name: "local-instance", role: "api" }),
  Object.freeze({ name: "projects", role: "api" }),
  Object.freeze({ name: "configuration", role: "api" }),
  Object.freeze({ name: "runtime-status", role: "api" }),
  Object.freeze({ name: "inference-gateway", role: "api" }),
  Object.freeze({ name: "workflow-engine", role: "scheduler" }),
  Object.freeze({ name: "capacity", role: "scheduler" }),
  Object.freeze({ name: "agent-generation", role: "sandbox" }),
  Object.freeze({ name: "artifact-production", role: "sandbox" }),
  Object.freeze({ name: "steam-release", role: "sandbox" }),
] as const);

export type CoreModuleName = typeof CORE_MODULES[number]["name"];
