export type ShellCapability =
  | "connections:manage"
  | "tenant-agents:manage"
  | "tenant-agents:view"
  | "invitations:manage"
  | "platform-agents:manage"
  | "platform-agents:view";

export type TenantShellRole = "TenantAdmin" | "ProjectOwner" | "Auditor";
export type AdminShellRole = "PlatformAgentAdmin" | "SecurityAdmin" | "Auditor";
export type TenantShellCapabilityOptions = Readonly<{ platformManagedConfiguration?: boolean }>;

export const LOCAL_SHELL_CAPABILITIES: readonly ShellCapability[] = Object.freeze([
  "connections:manage",
  "tenant-agents:manage",
  "invitations:manage",
  "platform-agents:manage",
]);

export function tenantShellCapabilities(role: TenantShellRole, options: TenantShellCapabilityOptions = {}): readonly ShellCapability[] {
  if (options.platformManagedConfiguration) {
    if (role === "TenantAdmin") return Object.freeze(["connections:manage", "invitations:manage"]);
    return Object.freeze(["connections:manage"]);
  }
  if (role === "TenantAdmin") {
    return Object.freeze(["connections:manage", "tenant-agents:manage", "invitations:manage"]);
  }
  if (role === "Auditor") return Object.freeze(["connections:manage", "tenant-agents:view"]);
  return Object.freeze(["connections:manage"]);
}

export function adminShellCapabilities(role: AdminShellRole): readonly ShellCapability[] {
  if (role === "Auditor") return Object.freeze(["platform-agents:view"]);
  return Object.freeze(["platform-agents:manage", "invitations:manage"]);
}
