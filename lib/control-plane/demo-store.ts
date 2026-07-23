/**
 * Local vertical-slice store used by the Sites preview and contract tests.
 * Production implementations persist the same immutable revisions in Postgres
 * (see infra/postgres/001_core.sql) and use Temporal for durable execution.
 */
import { builtInAdapterVersion, exactAdapterCompatibility, isAdapterVersionAttested } from "../agent/adapter-registry";
import { isManagedSmokeProjectId, localSmokeRunId } from "../local-smoke-project";

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
  familyId: string;
  label: string;
  scope: "platform" | "tenant";
  scopeId: string;
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
  approvedPorts: readonly number[];
  authentication: "bearer" | "x-api-key" | "authorization-bearer";
  models: {
    primaryModel: string;
    planningModel: string;
    smallFastModel: string;
    subagentModel: string;
  };
  pricing: {
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  };
  credentialVersionId: string;
  governance: {
    dataRegion: string;
    retentionPolicy: string;
    trainingPolicy: string;
    confirmedBy: string | null;
    confirmedAt: string | null;
  };
  state: "DRAFT" | "VALIDATING" | "READY" | "ACTIVE" | "DISABLED";
  probe: Record<string, "PASS" | "FAIL">;
};

export type DemoProfile = {
  id: string;
  revision: number;
  scope: "platform" | "tenant" | "project";
  scopeId: string;
  agent: "claude-code" | "codex-cli";
  providerRevisionId: string;
  installationId: string;
  credentialVersionId: string;
  state: "DRAFT" | "VALIDATING" | "READY" | "ACTIVE" | "SUPERSEDED" | "DEGRADED" | "DISABLED";
  budget: {
    maxUsd: number;
    maxTurns: number;
    timeoutSeconds: number;
  };
  fallbackProfileRevisionId: string | null;
  createdAt: string;
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
  validatedAdapterVersion: string | null;
  adapterCompatibility: Readonly<{ min: string; maxExclusive: string }> | null;
  validatedAt: string | null;
};

export type DemoStoreState = {
  specRevision: number;
  specState: "DRAFT" | "APPROVED";
  feedback: Array<{ projectId: string; id: string; text: string; revision: number; at: string }>;
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
  resourceSequences: {
    credential: number;
    provider: number;
    profile: number;
    audit: number;
  };
};

const initialState = (): DemoStoreState => {
  const now = Date.now();
  return ({
  specRevision: 8,
  specState: "APPROVED",
  feedback: [
    { projectId: "ember-archipelago", id: "ITER-006", text: "降低开局风暴频率", revision: 6, at: "2026-07-16T09:20:00.000Z" },
    { projectId: "ember-archipelago", id: "ITER-007", text: "修复返港结算后的存档回读", revision: 7, at: "2026-07-17T02:14:00.000Z" },
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
      approvedPorts: [443],
      authentication: "x-api-key",
      models: {
        primaryModel: "claude-sonnet-4-6-20250514",
        planningModel: "claude-sonnet-4-6-20250514",
        smallFastModel: "claude-haiku-4-5-20251001",
        subagentModel: "claude-sonnet-4-6-20250514",
      },
      pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
      credentialVersionId: "cred-claude-platform-v4",
      governance: {
        dataRegion: "Singapore",
        retentionPolicy: "Enterprise retention, maximum 30 days",
        trainingPolicy: "Source and prompts are not used for model training",
        confirmedBy: "SecurityAdmin",
        confirmedAt: "2026-07-18T08:30:00.000Z",
      },
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
      approvedPorts: [443],
      authentication: "bearer",
      models: {
        primaryModel: "gpt-5.3-codex-2026-06-12",
        planningModel: "gpt-5.3-codex-2026-06-12",
        smallFastModel: "gpt-5.3-mini-2026-06-12",
        subagentModel: "gpt-5.3-codex-2026-06-12",
      },
      pricing: { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10 },
      credentialVersionId: "cred-codex-platform-v2",
      governance: {
        dataRegion: "United States",
        retentionPolicy: "Zero data retention provider policy",
        trainingPolicy: "Source and prompts are not used for model training",
        confirmedBy: "SecurityAdmin",
        confirmedAt: "2026-07-17T18:05:00.000Z",
      },
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
      providerRevisionId: "provider-claude-platform-r3",
      installationId: "claude-installation-214",
      credentialVersionId: "cred-claude-platform-v4",
      state: "ACTIVE",
      budget: { maxUsd: 25, maxTurns: 64, timeoutSeconds: 7_200 },
      fallbackProfileRevisionId: null,
      createdAt: "2026-07-18T08:35:00.000Z",
    },
    {
      id: "profile-codex-project-r1",
      revision: 1,
      scope: "project",
      scopeId: "ember-archipelago",
      agent: "codex-cli",
      providerRevisionId: "provider-codex-platform-r2",
      installationId: "codex-installation-091",
      credentialVersionId: "cred-codex-platform-v2",
      state: "ACTIVE",
      budget: { maxUsd: 20, maxTurns: 64, timeoutSeconds: 7_200 },
      fallbackProfileRevisionId: null,
      createdAt: "2026-07-17T18:30:00.000Z",
    },
    {
      id: "profile-claude-tenant-r2",
      revision: 2,
      scope: "tenant",
      scopeId: "tenant-local",
      agent: "claude-code",
      providerRevisionId: "provider-claude-platform-r3",
      installationId: "claude-installation-214",
      credentialVersionId: "cred-claude-platform-v4",
      state: "ACTIVE",
      budget: { maxUsd: 22, maxTurns: 64, timeoutSeconds: 7_200 },
      fallbackProfileRevisionId: null,
      createdAt: "2026-07-18T08:36:00.000Z",
    },
    {
      id: "profile-codex-platform-r2",
      revision: 2,
      scope: "platform",
      scopeId: "global",
      agent: "codex-cli",
      providerRevisionId: "provider-codex-platform-r2",
      installationId: "codex-installation-091",
      credentialVersionId: "cred-codex-platform-v2",
      state: "ACTIVE",
      budget: { maxUsd: 20, maxTurns: 64, timeoutSeconds: 7_200 },
      fallbackProfileRevisionId: null,
      createdAt: "2026-07-17T18:28:00.000Z",
    },
  ],
  credentials: [],
  defaults: {
    platform: "profile-claude-platform-r5",
    "tenant:tenant-local": "profile-claude-tenant-r2",
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
  resourceSequences: { credential: 0, provider: 2, profile: 4, audit: 0 },
  });
};

const globalStore = globalThis as typeof globalThis & { __deviludoDemoStore?: DemoStoreState };

export function getDemoStore(): DemoStoreState {
  globalStore.__deviludoDemoStore ??= initialState();
  backfillProviderProfileShapes(globalStore.__deviludoDemoStore);
  backfillLocalFixtureTenantScope(globalStore.__deviludoDemoStore);
  backfillFeedbackProjectScope(globalStore.__deviludoDemoStore);
  backfillVersionMetadata(globalStore.__deviludoDemoStore);
  backfillCredentialTimestamps(globalStore.__deviludoDemoStore);
  backfillResourceSequences(globalStore.__deviludoDemoStore);
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
  backfillProviderProfileShapes(globalStore.__deviludoDemoStore);
  backfillLocalFixtureTenantScope(globalStore.__deviludoDemoStore);
  backfillFeedbackProjectScope(globalStore.__deviludoDemoStore);
  backfillVersionMetadata(globalStore.__deviludoDemoStore);
  backfillCredentialTimestamps(globalStore.__deviludoDemoStore);
  backfillResourceSequences(globalStore.__deviludoDemoStore);
  return globalStore.__deviludoDemoStore;
}

/** Upgrade v1 localhost snapshots without inventing a user confirmation. */
export function migrateDemoStoreState(snapshot: unknown): DemoStoreState {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("本地 Agent 管理状态结构无效");
  }
  const migrated = structuredClone(snapshot) as DemoStoreState;
  backfillProviderProfileShapes(migrated);
  backfillLocalFixtureTenantScope(migrated);
  backfillFeedbackProjectScope(migrated);
  backfillVersionMetadata(migrated);
  requireLegacyVersionRevalidation(migrated);
  backfillCredentialTimestamps(migrated);
  backfillResourceSequences(migrated);
  return migrated;
}

function backfillProviderProfileShapes(store: DemoStoreState): void {
  if (!Array.isArray(store.providers) || !Array.isArray(store.profiles)) return;
  for (const providerValue of store.providers as unknown as Record<string, unknown>[]) {
    const primaryModel = typeof providerValue.primaryModel === "string"
      ? providerValue.primaryModel
      : recordString(providerValue.models, "primaryModel");
    if (!providerValue.models && primaryModel) {
      providerValue.models = {
        primaryModel,
        planningModel: primaryModel,
        smallFastModel: primaryModel,
        subagentModel: primaryModel,
      };
    }
    if (!providerValue.pricing) {
      providerValue.pricing = {
        inputUsdPerMillionTokens: providerValue.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: providerValue.outputUsdPerMillionTokens,
      };
    }
    providerValue.approvedPorts ??= [443];
    providerValue.credentialVersionId ??= providerValue.credentialId;
    if (!providerValue.governance) {
      const knownFixture = providerValue.id === "provider-claude-platform-r3"
        || providerValue.id === "provider-codex-platform-r2";
      providerValue.governance = {
        dataRegion: knownFixture ? "fixture-provider-region" : "legacy-unrecorded",
        retentionPolicy: knownFixture ? "fixture enterprise retention policy" : "legacy-unrecorded",
        trainingPolicy: knownFixture ? "fixture no-training policy" : "legacy-unrecorded",
        confirmedBy: knownFixture ? "SecurityAdmin" : null,
        confirmedAt: knownFixture ? "2026-07-17T00:00:00.000Z" : null,
      };
    }
    delete providerValue.primaryModel;
    delete providerValue.inputUsdPerMillionTokens;
    delete providerValue.outputUsdPerMillionTokens;
    delete providerValue.credentialId;
  }
  for (const profileValue of store.profiles as unknown as Record<string, unknown>[]) {
    profileValue.providerRevisionId ??= profileValue.providerId;
    const provider = (store.providers as unknown as Record<string, unknown>[])
      .find((item) => item.id === profileValue.providerRevisionId);
    profileValue.credentialVersionId ??= provider?.credentialVersionId;
    if (!profileValue.budget) {
      profileValue.budget = {
        maxUsd: profileValue.budgetUsd,
        maxTurns: 64,
        timeoutSeconds: 7_200,
      };
    }
    profileValue.fallbackProfileRevisionId ??= profileValue.fallbackProfileId ?? null;
    profileValue.createdAt ??= "2026-07-17T00:00:00.000Z";
    delete profileValue.providerId;
    delete profileValue.budgetUsd;
    delete profileValue.fallbackProfileId;
  }
}

function backfillLocalFixtureTenantScope(store: DemoStoreState): void {
  const bundledTenantProfile = store.profiles.find((profile) => profile.id === "profile-claude-tenant-r2");
  if (bundledTenantProfile?.scope === "tenant" && bundledTenantProfile.scopeId === "north-dock") {
    bundledTenantProfile.scopeId = "tenant-local";
  }
  if (store.defaults["tenant:north-dock"] === "profile-claude-tenant-r2") {
    store.defaults["tenant:tenant-local"] ??= "profile-claude-tenant-r2";
    delete store.defaults["tenant:north-dock"];
  }
}

function backfillFeedbackProjectScope(store: DemoStoreState): void {
  if (!Array.isArray(store.feedback)) return;
  for (const feedback of store.feedback as unknown as Record<string, unknown>[]) {
    // v1-v3 localhost snapshots contained only the bundled fixture history.
    // Bind those legacy rows to that exact project instead of exposing them to
    // every newly created project.
    feedback.projectId ??= "ember-archipelago";
  }
}

function recordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
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

/**
 * v3 snapshots predate the immutable AgentVersion-to-Adapter proof. Never
 * synthesize that proof from the current registry: make the absence explicit
 * and return the version to discovery so an administrator must run the
 * trusted approval pipeline again before a new run can be locked.
 */
function requireLegacyVersionRevalidation(store: DemoStoreState): void {
  for (const [id, metadata] of Object.entries(store.agentVersionMetadata)) {
    if (metadata.validatedAdapterVersion === undefined) metadata.validatedAdapterVersion = null;
    if (metadata.adapterCompatibility === undefined) metadata.adapterCompatibility = null;
    const agent = id.startsWith("claude-code@") ? "claude-code"
      : id.startsWith("codex-cli@") ? "codex-cli" : null;
    const complete = agent !== null
      && typeof metadata.validationReceiptId === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(metadata.validationReceiptId)
      && /^sha256:[a-f0-9]{64}$/.test(metadata.validationReceiptDigest ?? "")
      && /^sha256:[a-f0-9]{64}$/.test(metadata.supplyChainEvidenceDigest ?? "")
      && typeof metadata.validatedAdapterVersion === "string"
      && metadata.adapterCompatibility !== null
      && isAdapterVersionAttested(
        builtInAdapterVersion(agent),
        metadata.validatedAdapterVersion,
        metadata.adapterCompatibility,
      );
    if (!complete && ["APPROVED", "DEPRECATED"].includes(store.agentVersions[id])) {
      store.agentVersions[id] = "DISCOVERED";
    }
  }
}

function backfillCredentialTimestamps(store: DemoStoreState): void {
  for (const credentialValue of store.credentials as unknown as Record<string, unknown>[]) {
    const credential = credentialValue as unknown as DemoCredential;
    credential.familyId ??= credential.id.replace(/-v\d+$/, "");
    // Old localhost snapshots carried no ownership proof. Treat them as
    // platform-only instead of guessing a tenant and risking metadata leaks.
    credential.scope ??= "platform";
    credential.scopeId ??= "global";
    if (credential.rotatedAt === undefined) credential.rotatedAt = null;
  }
}

function backfillResourceSequences(store: DemoStoreState): void {
  const current = (store as DemoStoreState & { resourceSequences?: Partial<DemoStoreState["resourceSequences"]> }).resourceSequences ?? {};
  store.resourceSequences = {
    credential: Math.max(safeSequence(current.credential), maxNumericId(store.credentials, /^credential-(\d+)-v\d+$/)),
    provider: Math.max(safeSequence(current.provider), maxNumericId(store.providers, /^provider-(?:claude-code|codex-cli)-(\d+)$/), 2),
    profile: Math.max(safeSequence(current.profile), maxNumericId(store.profiles, /^profile-(?:claude-code|codex-cli)-(\d+)-r\d+$/), 4),
    audit: Math.max(safeSequence(current.audit), maxNumericId(store.audit, /^AUD-(\d+)$/)),
  };
}

function maxNumericId(rows: readonly { id: string }[], pattern: RegExp, floor = 0): number {
  return rows.reduce((maximum, row) => {
    const value = Number(pattern.exec(row.id)?.[1] ?? 0);
    return Number.isSafeInteger(value) ? Math.max(maximum, value) : maximum;
  }, floor);
}

function safeSequence(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function fixtureVersionMetadata(
  agent: "claude-code" | "codex-cli",
  version: string,
  validated: boolean,
  discoveredAt: string,
): DemoAgentVersionMetadata {
  const id = `${agent}@${version}`;
  const validatedAdapterVersion = validated ? builtInAdapterVersion(agent) : null;
  const adapterCompatibility = validatedAdapterVersion ? exactAdapterCompatibility(validatedAdapterVersion) : null;
  const receiptBinding = `${id}:${validatedAdapterVersion ?? "pending"}:${adapterCompatibility?.min ?? "pending"}:${adapterCompatibility?.maxExclusive ?? "pending"}`;
  const seed = [...receiptBinding].reduce((sum, value) => (sum + value.charCodeAt(0)) % 16, 0).toString(16);
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
    validatedAdapterVersion,
    adapterCompatibility,
    validatedAt: validated ? discoveredAt : null,
  };
}

export type DemoSmokeAdminCleanupPlan = Readonly<{
  projectIds: readonly string[];
  credentialVersionIds: readonly string[];
  providerRevisionIds: readonly string[];
  profileRevisionIds: readonly string[];
}>;

export type DemoSmokeAdminCleanupResult = Readonly<{
  changed: boolean;
  credentials: number;
  providers: number;
  profiles: number;
  defaults: number;
  feedback: number;
  audit: number;
  idempotency: number;
}>;

/**
 * Builds an exact cleanup plan for resources created by the authenticated
 * localhost smoke suite. Ordinary tenant resources are never selected by a
 * prefix: credentials must carry the per-run label written by smoke.mjs.
 * The un-suffixed label is retained only to reclaim snapshots produced before
 * run labels were introduced.
 */
export function planDemoSmokeAdminCleanup(projectIds: readonly string[]): DemoSmokeAdminCleanupPlan {
  if (!projectIds.length || projectIds.some((projectId) => !isManagedSmokeProjectId(projectId))) {
    throw new Error("Local smoke administrator cleanup target is invalid");
  }
  const store = getDemoStore();
  const runIds = new Set(projectIds.map(localSmokeRunId).filter((value): value is string => value !== null));
  const labels = new Set([...runIds].map((runId) => `Smoke tenant Provider / ${runId}`));
  const families = new Set(store.credentials
    .filter((credential) => (credential.scope === "tenant" && credential.scopeId === "tenant-local" && labels.has(credential.label))
      // v1 snapshots predated credential ownership and were migrated to the
      // fail-closed platform scope. These two exact labels were reserved by
      // local integration checks and are therefore safe to reclaim.
      || credential.label === "Smoke tenant Provider"
      || credential.label === "local-sidecar-live-check")
    .map((credential) => credential.familyId));
  const credentialVersionIds = store.credentials
    .filter((credential) => families.has(credential.familyId))
    .map((credential) => credential.id);
  const credentials = new Set(credentialVersionIds);
  const providerRevisionIds = store.providers
    .filter((provider) => credentials.has(provider.credentialVersionId))
    .map((provider) => provider.id);
  const providers = new Set(providerRevisionIds);
  const profileRevisionIds = store.profiles
    .filter((profile) => providers.has(profile.providerRevisionId) || credentials.has(profile.credentialVersionId))
    .map((profile) => profile.id);
  return Object.freeze({
    projectIds: Object.freeze([...projectIds]),
    credentialVersionIds: Object.freeze(credentialVersionIds),
    providerRevisionIds: Object.freeze(providerRevisionIds),
    profileRevisionIds: Object.freeze(profileRevisionIds),
  });
}

/** Applies a previously computed plan without rewinding the monotonic IDs. */
export function applyDemoSmokeAdminCleanup(plan: DemoSmokeAdminCleanupPlan): DemoSmokeAdminCleanupResult {
  const store = getDemoStore();
  const projects = new Set(plan.projectIds);
  const credentials = new Set(plan.credentialVersionIds);
  const providers = new Set(plan.providerRevisionIds);
  const profiles = new Set(plan.profileRevisionIds);
  const removableProject = (value: string) => projects.has(value) || isManagedSmokeProjectId(value);
  const removed = {
    credentials: removeRows(store.credentials, (item) => credentials.has(item.id)),
    providers: removeRows(store.providers, (item) => providers.has(item.id)),
    profiles: removeRows(store.profiles, (item) => profiles.has(item.id)),
    defaults: removeRecordEntries(store.defaults, (scope, profileId) => {
      const projectId = scope.startsWith("project:") ? scope.slice("project:".length) : "";
      return profiles.has(profileId) || (projectId !== "" && removableProject(projectId));
    }),
    feedback: removeRows(store.feedback, (item) => removableProject(item.projectId)),
    audit: 0,
    idempotency: 0,
  };
  const references = new Set([
    ...plan.projectIds,
    ...plan.credentialVersionIds,
    ...plan.providerRevisionIds,
    ...plan.profileRevisionIds,
  ]);
  removed.audit = removeRows(store.audit, (event) => profiles.has(event.resource)
    || providers.has(event.resource)
    || credentials.has(event.resource)
    || (typeof event.metadata.projectId === "string" && removableProject(event.metadata.projectId))
    || (event.resource.startsWith("project:") && removableProject(event.resource.slice("project:".length))));
  removed.idempotency = removeRecordEntries(store.idempotency, (key, value) =>
    [...projects].some((projectId) => key.includes(projectId)) || referencesValue(value, references));
  const changed = Object.values(removed).some((count) => count > 0);
  return Object.freeze({ changed, ...removed });
}

function removeRows<T>(rows: T[], predicate: (item: T) => boolean): number {
  const retained = rows.filter((item) => !predicate(item));
  const removed = rows.length - retained.length;
  if (removed) rows.splice(0, rows.length, ...retained);
  return removed;
}

function removeRecordEntries<T>(record: Record<string, T>, predicate: (key: string, value: T) => boolean): number {
  let removed = 0;
  for (const [key, value] of Object.entries(record)) {
    if (!predicate(key, value)) continue;
    delete record[key];
    removed += 1;
  }
  return removed;
}

function referencesValue(value: unknown, references: ReadonlySet<string>): boolean {
  if (typeof value === "string") return references.has(value) || isManagedSmokeProjectId(value);
  if (Array.isArray(value)) return value.some((item) => referencesValue(item, references));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => referencesValue(item, references));
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
  store.resourceSequences.audit += 1;
  const event: DemoAuditEvent = {
    id: `AUD-${String(store.resourceSequences.audit).padStart(5, "0")}`,
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
