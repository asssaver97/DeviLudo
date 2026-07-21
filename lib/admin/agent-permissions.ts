import type { AdminRole } from "./agent-ui";

export interface AgentAdminCapabilities {
  readonly manageVersions: boolean;
  readonly manageInstallations: boolean;
  readonly changePlatformDefault: boolean;
  readonly editPlatformProvider: boolean;
  readonly activatePlatformProvider: boolean;
  readonly manageGlobalCredentials: boolean;
}

const NONE: AgentAdminCapabilities = Object.freeze({
  manageVersions: false,
  manageInstallations: false,
  changePlatformDefault: false,
  editPlatformProvider: false,
  activatePlatformProvider: false,
  manageGlobalCredentials: false,
});

const CAPABILITIES: Readonly<Record<AdminRole, AgentAdminCapabilities>> = Object.freeze({
  PlatformAgentAdmin: Object.freeze({
    manageVersions: true,
    manageInstallations: true,
    changePlatformDefault: true,
    editPlatformProvider: true,
    activatePlatformProvider: false,
    manageGlobalCredentials: false,
  }),
  SecurityAdmin: Object.freeze({
    manageVersions: false,
    manageInstallations: false,
    changePlatformDefault: false,
    editPlatformProvider: true,
    activatePlatformProvider: true,
    manageGlobalCredentials: true,
  }),
  TenantAdmin: NONE,
  ProjectOwner: NONE,
  Auditor: NONE,
});

/** Capabilities for this platform-scoped Agent console, not tenant/project pages. */
export function agentAdminCapabilities(role: AdminRole): AgentAdminCapabilities {
  return CAPABILITIES[role];
}
