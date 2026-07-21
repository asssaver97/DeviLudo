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

export type DemoUsageRecord = {
  requestId: string;
  tenantId: string;
  projectId: string;
  runId: string;
  providerRevisionId: string;
  credentialVersionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordedAt: string;
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
  rotatedAt: string | null;
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
  drainingAt: string | null;
  retiredAt: string | null;
};

export type DemoAgentVersionState = "DISCOVERED" | "VALIDATING" | "APPROVED" | "DEPRECATED" | "BLOCKED" | "REJECTED";

export type DemoAgentVersionMetadata = {
  source: string;
  sourceDigest: string;
  releaseNotesUrl: string;
  discoveredAt: string;
  integrity: string | null;
  signatureVerified: boolean;
  sbomRef: string | null;
  scan: "PASS" | "FAIL" | "PENDING";
  validationReceiptId: string | null;
  validationReceiptDigest: string | null;
  supplyChainEvidenceDigest: string | null;
  validatedAt: string | null;
};

export type DemoStoreState = {
  specRevision: number;
  specState: "DRAFT" | "APPROVED";
  feedback: Array<{ id: string; text: string; revision: number; at: string }>;
  invalidatedEvidence: string[];
  agentVersions: Record<string, DemoAgentVersionState>;
  agentVersionMetadata: Record<string, DemoAgentVersionMetadata>;
  installations: DemoInstallation[];
  rollouts: Record<string, { percent: 0 | 5 | 25 | 100; state: string; previous: number }>;
  providers: DemoProvider[];
  profiles: DemoProfile[];
  credentials: DemoCredential[];
  defaults: Record<string, string>;
  audit: DemoAuditEvent[];
  usage: DemoUsageRecord[];
  idempotency: Record<string, unknown>;
};

const initialState = (): DemoStoreState => {
  const now = Date.now();
  return ({
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
  agentVersionMetadata: {
    "claude-code@2.1.14": fixtureVersionMetadata("claude-code", "2.1.14", true, "2026-07-18T08:32:00.000Z"),
    "claude-code@2.1.15": fixtureVersionMetadata("claude-code", "2.1.15", false, "2026-07-20T06:10:00.000Z"),
    "codex-cli@0.91.0": fixtureVersionMetadata("codex-cli", "0.91.0", true, "2026-07-17T18:10:00.000Z"),
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
      drainingAt: null,
      retiredAt: null,
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
      drainingAt: null,
      retiredAt: null,
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
      id: "profile-claude-tenant-r2",
      revision: 2,
      scope: "tenant",
      scopeId: "north-dock",
      agent: "claude-code",
      providerId: "provider-claude-platform-r3",
      installationId: "claude-installation-214",
      state: "ACTIVE",
      budgetUsd: 22,
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
  usage: [
    {
      requestId: "44444444-4444-4444-8444-444444444441",
      tenantId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333331",
      providerRevisionId: "provider-claude-platform-r3",
      credentialVersionId: "cred-claude-platform-v4",
      model: "claude-sonnet-4-6-20250514",
      inputTokens: 18420,
      outputTokens: 6320,
      costUsd: 0.1491,
      recordedAt: new Date(now - 8 * 60_000).toISOString(),
    },
    {
      requestId: "44444444-4444-4444-8444-444444444442",
      tenantId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333332",
      providerRevisionId: "provider-codex-tenant-r2",
      credentialVersionId: "cred-codex-tenant-v2",
      model: "gpt-5.4-2026-06-18",
      inputTokens: 9200,
      outputTokens: 2840,
      costUsd: 0.0714,
      recordedAt: new Date(now - 41 * 60_000).toISOString(),
    },
  ],
  idempotency: {},
  });
};

const globalStore = globalThis as typeof globalThis & { __deviludoDemoStore?: DemoStoreState };

export function getDemoStore(): DemoStoreState {
  globalStore.__deviludoDemoStore ??= initialState();
  backfillVersionMetadata(globalStore.__deviludoDemoStore);
  backfillCredentialTimestamps(globalStore.__deviludoDemoStore);
  return globalStore.__deviludoDemoStore;
}

export function resetDemoStore(): DemoStoreState {
  globalStore.__deviludoDemoStore = initialState();
  return globalStore.__deviludoDemoStore;
}

/**
 * Replaces the process-local projection with a previously validated durable
 * snapshot. Validation belongs to the persistence boundary so ordinary
 * callers cannot hydrate arbitrary data into the control-plane projection.
 */
export function restoreDemoStore(snapshot: DemoStoreState): DemoStoreState {
  globalStore.__deviludoDemoStore = structuredClone(snapshot);
  backfillVersionMetadata(globalStore.__deviludoDemoStore);
  backfillCredentialTimestamps(globalStore.__deviludoDemoStore);
  return globalStore.__deviludoDemoStore;
}

function backfillVersionMetadata(store: DemoStoreState): void {
  store.agentVersionMetadata ??= {};
  for (const [id, state] of Object.entries(store.agentVersions)) {
    if (store.agentVersionMetadata[id]) continue;
    const separator = id.lastIndexOf("@");
    const agent = id.slice(0, separator);
    const version = id.slice(separator + 1);
    if ((agent === "claude-code" || agent === "codex-cli") && version) {
      store.agentVersionMetadata[id] = fixtureVersionMetadata(agent, version, state === "APPROVED", new Date().toISOString());
    }
  }
}

function backfillCredentialTimestamps(store: DemoStoreState): void {
  for (const credential of store.credentials) {
    if (credential.rotatedAt === undefined) credential.rotatedAt = null;
  }
}

function fixtureVersionMetadata(
  agent: "claude-code" | "codex-cli",
  version: string,
  validated: boolean,
  discoveredAt: string,
): DemoAgentVersionMetadata {
  const id = `${agent}@${version}`;
  const seed = [...id].reduce((sum, value) => (sum + value.charCodeAt(0)) % 16, 0).toString(16);
  const evidenceSeed = ((Number.parseInt(seed, 16) + 7) % 16).toString(16);
  return {
    source: agent === "claude-code"
      ? `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`
      : `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`,
    sourceDigest: `sha256:${seed.repeat(64)}`,
    releaseNotesUrl: agent === "claude-code"
      ? "https://github.com/anthropics/claude-code/releases"
      : "https://github.com/openai/codex/releases",
    discoveredAt,
    integrity: validated ? `sha256:${evidenceSeed.repeat(64)}` : null,
    signatureVerified: validated,
    sbomRef: validated ? `urn:deviludo:local-sbom:${agent}:${version}` : null,
    scan: validated ? "PASS" : "PENDING",
    validationReceiptId: validated ? `local-validation-${agent}-${version}` : null,
    validationReceiptDigest: validated ? `sha256:${evidenceSeed.repeat(64)}` : null,
    supplyChainEvidenceDigest: validated ? `sha256:${seed.repeat(64)}` : null,
    validatedAt: validated ? discoveredAt : null,
  };
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
