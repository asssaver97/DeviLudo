export const E2E_INFRASTRUCTURE_DOMAINS = ["NODE", "VM", "GODOT_RUNTIME", "NETWORK"] as const;
export type E2eInfrastructureDomain = typeof E2E_INFRASTRUCTURE_DOMAINS[number];

export type E2eInfrastructureFailure = Readonly<{
  classification: "INFRASTRUCTURE";
  domain: E2eInfrastructureDomain;
  reason: string;
}>;

export function classifyE2eInfrastructureFailure(error: unknown): E2eInfrastructureFailure {
  const reason = sanitizeFailureReason(errorMessages(error).join(" | "));
  const domain: E2eInfrastructureDomain = /reimage|isolation|cleanup|golden|Hyper-V|KVM|libvirt|Tart|virtual machine|\bVM\b/i.test(reason)
    ? "VM"
    : /ECONN|ENET|EAI_AGAIN|ETIMEDOUT|socket|Core returned|Artifact (?:download|upload)|signing broker/i.test(reason)
      ? "NETWORK"
      : /Godot|guest runner|game runtime|app bundle|runtime executable/i.test(reason)
        ? "GODOT_RUNTIME"
        : "NODE";
  return Object.freeze({ classification: "INFRASTRUCTURE", domain, reason });
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    const nested = [...error.errors].flatMap(errorMessages).filter(Boolean);
    return nested.length ? nested : [error.message];
  }
  if (error instanceof Error) {
    const cause = "cause" in error && error.cause !== undefined ? errorMessages(error.cause) : [];
    return [error.message, ...cause].filter(Boolean);
  }
  return [String(error)];
}

function sanitizeFailureReason(value: string): string {
  return value.replaceAll(/[\u0000-\u001f]+/g, " ").replaceAll(/\s+/g, " ").trim().slice(0, 2_000)
    || "E2E infrastructure failure";
}
