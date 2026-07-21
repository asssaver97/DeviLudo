import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type {
  AdminMutationClaimBinding,
  AdminRole,
  AgentVersionRecord,
  AgentUsageSummary,
  AuditRecord,
  CredentialVersionRecord,
  InstallationRecord,
  ProfileRevisionRecord,
  ProviderRevisionRecord,
  RequestActor,
} from "./contracts";

export interface AdminCatalogState {
  readonly versions: Map<string, AgentVersionRecord>;
  readonly installations: Map<string, InstallationRecord>;
  readonly providers: Map<string, ProviderRevisionRecord>;
  readonly profiles: Map<string, ProfileRevisionRecord>;
  readonly credentials: Map<string, CredentialVersionRecord>;
  readonly defaults: Map<string, string>;
  readonly audit: AuditRecord[];
}

export interface AdminMutationCompletion<T> extends AdminMutationClaimBinding {
  /** Must produce the exact already-redacted controller payload. */
  readonly payload: (result: T) => unknown;
}

export abstract class AdminStore {
  abstract read<T>(operation: (state: AdminCatalogState) => T): Promise<T>;
  /** Tenant/project-scoped immutable inference usage projection for administrators. */
  abstract readUsage(actor: RequestActor): Promise<AgentUsageSummary>;
  /** Global, fail-closed retirement guard for immutable AgentRun bindings. */
  abstract countNonTerminalRuns(installationId: string): Promise<number>;
  abstract mutate<T>(
    operation: (state: AdminCatalogState) => T,
    completion?: AdminMutationCompletion<T>,
  ): Promise<T>;
}

export class InMemoryAdminStore extends AdminStore {
  readonly #state = seededState();

  async read<T>(operation: (state: AdminCatalogState) => T): Promise<T> {
    return operation(this.#state);
  }

  async readUsage(): Promise<AgentUsageSummary> {
    return emptyUsageSummary(false);
  }

  async countNonTerminalRuns(): Promise<number> { return 0; }

  async mutate<T>(
    operation: (state: AdminCatalogState) => T,
  ): Promise<T> {
    return operation(this.#state);
  }
}

export function emptyUsageSummary(available: boolean, now = new Date()): AgentUsageSummary {
  return Object.freeze({
    available,
    source: "inference_usage_events",
    windowStartedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    credentialLastUsedAt: Object.freeze({}),
    totals: Object.freeze({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    records: Object.freeze([]),
  });
}

export function emptyAdminCatalogState(): AdminCatalogState {
  return {
    versions: new Map(),
    installations: new Map(),
    providers: new Map(),
    profiles: new Map(),
    credentials: new Map(),
    defaults: new Map(),
    audit: [],
  };
}

export function recordAdminAudit(
  state: AdminCatalogState,
  input: {
    action: string;
    resource: string;
    role: AdminRole;
    actorId: string;
    tenantId: string | null;
    projectId: string | null;
    requestId: string;
    metadata?: Readonly<Record<string, unknown>>;
  },
): AuditRecord {
  const record: AuditRecord = Object.freeze({
    id: `audit-${randomUUID()}`,
    action: input.action,
    resource: input.resource,
    actorRole: input.role,
    actorId: input.actorId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    requestId: input.requestId,
    at: new Date().toISOString(),
    metadata: Object.freeze(redact(input.metadata ?? {})),
  });
  state.audit.unshift(record);
  return record;
}

function seededState(): AdminCatalogState {
  const state = emptyAdminCatalogState();
  const now = new Date().toISOString();
  const claudeVersion = seededAgentVersion("claude-code", "2.1.14", "https://code.claude.com/docs/en/installation", "1", now);
  const codexVersion = seededAgentVersion("codex-cli", "0.91.0", "https://github.com/openai/codex", "2", now);
  state.versions.set(claudeVersion.id, claudeVersion);
  state.versions.set(codexVersion.id, codexVersion);

  const credential: CredentialVersionRecord = {
    id: "credential-platform-claude-v1",
    familyId: "credential-platform-claude",
    version: 1,
    label: "Platform Claude gateway key",
    scope: "platform",
    scopeId: "global",
    secretRef: "vault://kv/data/deviludo/platform/claude?version=1",
    maskedFingerprint: "sha256:managed0…000001",
    state: "ACTIVE",
    createdAt: now,
    rotatedAt: null,
    lastUsedAt: null,
  };
  const installation: InstallationRecord = {
    id: "claude-code-installation-2-1-14",
    agent: "claude-code",
    agentVersionId: claudeVersion.id,
    workerPool: "development-linux-primary",
    imageDigest: `sha256:${"a".repeat(64)}`,
    workerImageId: "worker-image-claude-code-2-1-14",
    adapterVersion: "1.0.0",
    buildReceiptId: "build-claude-code-installation-2-1-14",
    buildReceiptDigest: "a".repeat(64),
    rollbackInstallationId: null,
    health: "HEALTHY",
    state: "ACTIVE",
    rolloutPercent: 100,
    previousRolloutPercent: 25,
    selfUpdateDisabled: true,
    createdAt: now,
    activatedAt: now,
    drainingAt: null,
    retiredAt: null,
  };
  const provider: ProviderRevisionRecord = {
    id: "provider-platform-claude-r1",
    revision: 1,
    agent: "claude-code",
    protocol: "anthropic-messages",
    baseUrl: "https://gateway.anthropic.com/",
    approvedPorts: Object.freeze([443]),
    authentication: "x-api-key",
    models: {
      primaryModel: "claude-sonnet-4-6-20250514",
      planningModel: "claude-sonnet-4-6-20250514",
      smallFastModel: "claude-sonnet-4-6-20250514",
      subagentModel: "claude-sonnet-4-6-20250514",
    },
    pricing: Object.freeze({
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    }),
    credentialVersionId: credential.id,
    state: "ACTIVE",
    probe: {
      authentication: "PASS",
      modelExistence: "PASS",
      streaming: "PASS",
      toolCalling: "PASS",
      cancellation: "PASS",
      usage: "PASS",
      timeout: "PASS",
      minimalReasoning: "PASS",
      dnsPinning: "PASS",
      redirectRevalidation: "PASS",
    },
    governance: {
      dataRegion: "vendor-managed",
      retentionPolicy: "platform-approved",
      trainingPolicy: "no-training",
      confirmedBy: "bootstrap",
      confirmedAt: now,
    },
  };
  const profile: ProfileRevisionRecord = {
    id: "profile-platform-claude-r1",
    revision: 1,
    scope: "platform",
    scopeId: "global",
    agent: "claude-code",
    installationId: installation.id,
    providerRevisionId: provider.id,
    credentialVersionId: credential.id,
    budget: { maxUsd: 25, maxTurns: 100, timeoutSeconds: 7200 },
    fallbackProfileRevisionId: null,
    state: "ACTIVE",
    createdAt: now,
  };
  state.credentials.set(credential.id, credential);
  state.installations.set(installation.id, installation);
  state.providers.set(provider.id, provider);
  state.profiles.set(profile.id, profile);
  state.defaults.set("platform", profile.id);
  return state;
}

function seededAgentVersion(
  agent: AgentVersionRecord["agent"],
  version: string,
  source: string,
  seed: string,
  now: string,
): AgentVersionRecord {
  const candidate = {
    agent,
    version,
    source,
    sourceDigest: seed.repeat(64),
    releaseNotesUrl: agent === "claude-code"
      ? "https://github.com/anthropics/claude-code/releases"
      : "https://github.com/openai/codex/releases",
    catalogReceiptId: `catalog-${agent}-${version}`,
    discoveredAt: now,
  };
  const catalogReceiptDigest = sha256Canonical(candidate);
  const validation = {
    agent,
    version,
    sourceDigest: candidate.sourceDigest,
    integrity: `sha256:${seed.repeat(64)}`,
    signatureVerified: true as const,
    sbomRef: `oci://registry.internal/sbom/${agent}-${version}.spdx.json`,
    scan: "PASS" as const,
    supplyChainEvidenceDigest: sha256Canonical({ agent, version, seed }),
    validationReceiptId: `validation-${agent}-${version}`,
    validatedAt: now,
  };
  return {
    id: `${agent}@${version}`,
    ...candidate,
    catalogReceiptDigest,
    state: "APPROVED",
    integrity: validation.integrity,
    signatureVerified: true,
    sbomRef: validation.sbomRef,
    scan: "PASS",
    validationReceiptId: validation.validationReceiptId,
    validationReceiptDigest: sha256Canonical(validation),
    supplyChainEvidenceDigest: validation.supplyChainEvidenceDigest,
    validatedAt: now,
  };
}

const REDACTED_KEY = /(api[-_]?key|secret|password|token|authorization|credential)/i;

function redact(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      REDACTED_KEY.test(key) ? "[REDACTED]" : redactValue(child),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redact(value as Record<string, unknown>);
  return value;
}
