/**
 * Local vertical-slice store used by the Sites preview and contract tests.
 * Production implementations persist the same immutable revisions in Postgres
 * (see infra/postgres/001_core.sql) and use Temporal for durable execution.
 */
export type DemoAuditEvent = {
  id: string;
  action: string;
  resource: string;
  actor: string;
  at: string;
  metadata: Record<string, string | number | boolean>;
};

export type DemoCredential = {
  id: string;
  label: string;
  secretRef: string;
  fingerprint: string;
  masked: string;
  version: number;
  state: "ACTIVE" | "PREVIOUS" | "REVOKED";
  createdAt: string;
};

export type DemoProvider = {
  id: string;
  revision: number;
  agent: "claude-code" | "codex-cli";
  protocol: "anthropic-messages" | "openai-responses";
  baseUrl: string;
  authentication: "bearer" | "x-api-key" | "authorization-bearer";
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  primaryModel: string;
  credentialId: string;
  state: "DRAFT" | "VALIDATING" | "READY" | "ACTIVE" | "DISABLED";
  probe: Record<string, "PASS" | "FAIL">;
};

export type DemoProfile = {
  id: string;
  revision: number;
  scope: "platform" | "tenant" | "project";
  scopeId: string;
  agent: "claude-code" | "codex-cli";
  providerId: string;
  installationId: string;
  state: "DRAFT" | "VALIDATING" | "READY" | "ACTIVE" | "SUPERSEDED" | "DEGRADED" | "DISABLED";
  budgetUsd: number;
  fallbackProfileId: string | null;
};

export type DemoInstallation = {
  id: string;
  agent: "claude-code" | "codex-cli";
  version: string;
  workerPool: string;
  adapterVersion: string;
  imageDigest: `sha256:${string}`;
  buildReceiptId: string;
  buildReceiptDigest: `sha256:${string}`;
  state: string;
  health: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  rolloutPercent: 0 | 5 | 25 | 100;
  rollbackInstallationId: string | null;
  createdAt: string;
  activatedAt: string | null;
};

export type DemoStoreState = {
  specRevision: number;
  specState: "DRAFT" | "APPROVED";
  feedback: Array<{ id: string; text: string; revision: number; at: string }>;
  invalidatedEvidence: string[];
  agentVersions: Record<string, "DISCOVERED" | "VALIDATING" | "APPROVED" | "DEPRECATED" | "BLOCKED" | "REJECTED">;
  installations: DemoInstallation[];
  rollouts: Record<string, { percent: 0 | 5 | 25 | 100; state: string; previous: number }>;
  providers: DemoProvider[];
  profiles: DemoProfile[];
  credentials: DemoCredential[];
  defaults: Record<string, string>;
  audit: DemoAuditEvent[];
  idempotency: Record<string, unknown>;
};

const initialState = (): DemoStoreState => ({
  specRevision: 8,
  specState: "APPROVED",
  feedback: [
    { id: "ITER-006", text: "降低开局风暴频率", revision: 6, at: "2026-07-16T09:20:00.000Z" },
    { id: "ITER-007", text: "修复返港结算后的存档回读", revision: 7, at: "2026-07-17T02:14:00.000Z" },
  ],
  invalidatedEvidence: [],
  agentVersions: {
    "claude-code@2.1.14": "APPROVED",
    "claude-code@2.1.15": "DISCOVERED",
    "codex-cli@0.91.0": "APPROVED",
  },
  installations: [
    {
      id: "claude-installation-214",
      agent: "claude-code",
      version: "2.1.14",
      workerPool: "dev-linux-a",
      adapterVersion: "1.3.0",
      imageDigest: `sha256:${"0a7c".padEnd(64, "9")}`,
      buildReceiptId: "local-build-claude-214",
      buildReceiptDigest: `sha256:${"a214".padEnd(64, "1")}`,
      state: "ACTIVE",
      health: "HEALTHY",
      rolloutPercent: 100,
      rollbackInstallationId: null,
      createdAt: "2026-07-18T08:42:00.000Z",
      activatedAt: "2026-07-18T08:50:00.000Z",
    },
    {
      id: "codex-installation-091",
      agent: "codex-cli",
      version: "0.91.0",
      workerPool: "dev-linux-b",
      adapterVersion: "1.2.2",
      imageDigest: `sha256:${"812e".padEnd(64, "f")}`,
      buildReceiptId: "local-build-codex-091",
      buildReceiptDigest: `sha256:${"b091".padEnd(64, "2")}`,
      state: "ACTIVE",
      health: "HEALTHY",
      rolloutPercent: 100,
      rollbackInstallationId: null,
      createdAt: "2026-07-17T18:20:00.000Z",
      activatedAt: "2026-07-17T18:25:00.000Z",
    },
  ],
  rollouts: {
    "claude-installation-214": { percent: 100, state: "ACTIVE", previous: 25 },
    "codex-installation-091": { percent: 100, state: "ACTIVE", previous: 25 },
  },
  providers: [
    {
      id: "provider-claude-platform-r3",
      revision: 3,
      agent: "claude-code",
      protocol: "anthropic-messages",
      baseUrl: "https://gateway.anthropic.example/v1",
      authentication: "x-api-key",
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      primaryModel: "claude-sonnet-4-6-20250514",
      credentialId: "cred-claude-platform-v4",
      state: "ACTIVE",
      probe: {
        authentication: "PASS", modelExistence: "PASS", streaming: "PASS", toolCalling: "PASS",
        cancellation: "PASS", usage: "PASS", timeout: "PASS", minimalReasoning: "PASS",
        dnsPinning: "PASS", redirectRevalidation: "PASS",
      },
    },
    {
      id: "provider-codex-platform-r2",
      revision: 2,
      agent: "codex-cli",
      protocol: "openai-responses",
      baseUrl: "https://responses.openai.example/v1",
      authentication: "bearer",
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 10,
      primaryModel: "gpt-5.3-codex-2026-06-12",
      credentialId: "cred-codex-platform-v2",
      state: "ACTIVE",
      probe: {
        authentication: "PASS", modelExistence: "PASS", streaming: "PASS", toolCalling: "PASS",
        cancellation: "PASS", usage: "PASS", timeout: "PASS", minimalReasoning: "PASS",
        dnsPinning: "PASS", redirectRevalidation: "PASS",
      },
    },
  ],
  profiles: [
    {
      id: "profile-claude-platform-r5",
      revision: 5,
      scope: "platform",
      scopeId: "global",
      agent: "claude-code",
      providerId: "provider-claude-platform-r3",
      installationId: "claude-installation-214",
      state: "ACTIVE",
      budgetUsd: 25,
      fallbackProfileId: null,
    },
    {
      id: "profile-codex-project-r1",
      revision: 1,
      scope: "project",
      scopeId: "ember-archipelago",
      agent: "codex-cli",
      providerId: "provider-codex-platform-r2",
      installationId: "codex-installation-091",
      state: "ACTIVE",
      budgetUsd: 20,
      fallbackProfileId: null,
    },
    {
      id: "profile-codex-platform-r2",
      revision: 2,
      scope: "platform",
      scopeId: "global",
      agent: "codex-cli",
      providerId: "provider-codex-platform-r2",
      installationId: "codex-installation-091",
      state: "ACTIVE",
      budgetUsd: 20,
      fallbackProfileId: null,
    },
  ],
  credentials: [],
  defaults: {
    platform: "profile-claude-platform-r5",
    "tenant:north-dock": "profile-claude-tenant-r2",
    "project:ember-archipelago": "profile-codex-project-r1",
  },
  audit: [],
  idempotency: {},
});

const globalStore = globalThis as typeof globalThis & { __deviludoDemoStore?: DemoStoreState };

export function getDemoStore(): DemoStoreState {
  globalStore.__deviludoDemoStore ??= initialState();
  return globalStore.__deviludoDemoStore;
}

export function resetDemoStore(): DemoStoreState {
  globalStore.__deviludoDemoStore = initialState();
  return globalStore.__deviludoDemoStore;
}

export function withIdempotency<T>(key: string, operation: () => T): { replayed: boolean; value: T } {
  const store = getDemoStore();
  if (Object.prototype.hasOwnProperty.call(store.idempotency, key)) {
    return { replayed: true, value: store.idempotency[key] as T };
  }
  const value = operation();
  store.idempotency[key] = value;
  return { replayed: false, value };
}

export function appendDemoAudit(
  action: string,
  resource: string,
  actor: string,
  metadata: Record<string, string | number | boolean> = {},
): DemoAuditEvent {
  const store = getDemoStore();
  const event: DemoAuditEvent = {
    id: `AUD-${String(store.audit.length + 1).padStart(5, "0")}`,
    action,
    resource,
    actor,
    at: new Date().toISOString(),
    metadata: Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [/(key|secret|password|token|authorization)/i.test(key) ? `${key}_redacted` : key, /(key|secret|password|token|authorization)/i.test(key) ? "[REDACTED]" : value]),
    ) as Record<string, string | number | boolean>,
  };
  store.audit.unshift(event);
  return event;
}
