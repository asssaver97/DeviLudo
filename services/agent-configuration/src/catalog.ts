import { assertPinnedModelId } from "../../../lib/agent/providers";
import { validateProviderBaseUrl } from "../../../lib/security/network";
import type { AgentKind } from "./contracts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const EXACT_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/;

export interface ResolvedProfileConfiguration {
  readonly profileRevisionId: string;
  readonly agent: AgentKind;
  readonly installationId: string;
  readonly workerPool: string;
  readonly imageDigest: string;
  readonly workerImageId: string;
  readonly adapterVersion: string;
  readonly buildReceiptId: string;
  readonly buildReceiptDigest: string;
  readonly agentVersionId: string;
  readonly exactAgentVersion: string;
  readonly agentVersionSourceDigest: string;
  readonly providerRevisionId: string;
  readonly providerProtocol: "anthropic-messages" | "openai-responses";
  readonly providerBaseUrl: string;
  readonly providerApprovedPorts: readonly number[];
  readonly providerAuthentication: "x-api-key" | "authorization-bearer" | "bearer";
  readonly providerPricing: Readonly<{
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  }>;
  readonly providerGovernance: Readonly<{
    dataRegion: string;
    retentionPolicy: string;
    trainingPolicy: string;
    confirmedBy: string;
    confirmedAt: string;
  }>;
  readonly modelRoles: Readonly<{
    primaryModel: string;
    planningModel: string;
    smallFastModel: string;
    subagentModel: string;
  }>;
  readonly credentialVersionId: string;
  readonly budget: Readonly<{ maxUsd: number; maxTurns: number; timeoutSeconds: number }>;
}

export interface ResolvedCatalogConfiguration extends ResolvedProfileConfiguration {
  readonly catalogRevision: string;
  readonly profileSource: string;
  readonly fallback: ResolvedProfileConfiguration | null;
}

/** Resolves one coherent administrator catalog revision, including only a project-approved fallback. */
export function resolveCatalogConfiguration(input: {
  readonly revision: string | number | bigint;
  readonly payload: unknown;
  readonly tenantId: string;
  readonly projectId: string;
}): ResolvedCatalogConfiguration {
  const catalogRevision = integerString(input.revision);
  const payload = object(input.payload, "catalog");
  const profiles = index(payload.profiles, "profile");
  const providers = index(payload.providers, "provider");
  const installations = index(payload.installations, "installation");
  const versions = index(payload.versions, "version");
  const credentials = index(payload.credentials, "credential");
  const defaults = defaultIndex(payload.defaults);
  const selected = [
    `project:${input.projectId}`,
    `tenant:${input.tenantId}`,
    "platform",
  ].find((scope) => defaults.has(scope));
  if (!selected) invalid("No active Agent default is configured");
  const profileId = defaults.get(selected);
  const profile = requireRecord(profiles, profileId, "profile");
  const primary = resolveProfileConfiguration({
    profile,
    selectedDefault: selected,
    tenantId: input.tenantId,
    projectId: input.projectId,
    providers,
    installations,
    versions,
    credentials,
  });
  let fallback: ResolvedProfileConfiguration | null = null;
  const fallbackValue = profile.fallbackProfileRevisionId;
  if (fallbackValue !== undefined && fallbackValue !== null) {
    const fallbackProfileId = safeId(fallbackValue);
    if (fallbackProfileId === primary.profileRevisionId) invalid("Agent fallback Profile cannot reference itself");
    if (selected === `project:${input.projectId}`) {
      fallback = resolveProfileConfiguration({
        profile: requireRecord(profiles, fallbackProfileId, "fallback profile"),
        selectedDefault: selected,
        tenantId: input.tenantId,
        projectId: input.projectId,
        providers,
        installations,
        versions,
        credentials,
      });
      if (fallback.agent !== primary.agent) invalid("Agent fallback must use the same Agent kind");
    }
  }
  return Object.freeze({
    catalogRevision,
    profileSource: selected,
    ...primary,
    fallback,
  });
}

function resolveProfileConfiguration(input: {
  readonly profile: Readonly<Record<string, unknown>>;
  readonly selectedDefault: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly providers: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly installations: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly versions: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly credentials: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}): ResolvedProfileConfiguration {
  const { profile, providers, installations, versions, credentials } = input;
  if (profile.state !== "ACTIVE") {
    invalid("Selected Agent Profile is inactive or belongs to another scope");
  }
  const profileScope = selectableProfileScope(profile, input.selectedDefault, input.tenantId, input.projectId);
  const agent = agentKind(profile.agent);
  const installationId = safeId(profile.installationId);
  const providerRevisionId = safeId(profile.providerRevisionId);
  const credentialVersionId = safeId(profile.credentialVersionId);
  const installation = requireRecord(installations, installationId, "installation");
  if (installation.agent !== agent || installation.state !== "ACTIVE"
    || installation.health !== "HEALTHY" || installation.rolloutPercent !== 100
    || installation.selfUpdateDisabled !== true) {
    invalid("Selected Agent installation is not fully active and healthy");
  }
  const workerPool = text(installation.workerPool, 200);
  if (!workerPool.startsWith("development-")) invalid("Agent installation is outside a development Worker pool");
  const imageDigest = match(installation.imageDigest, IMAGE_DIGEST, "image digest");
  const workerImageId = safeId(installation.workerImageId);
  const adapterVersion = exactVersion(installation.adapterVersion);
  const buildReceiptId = safeId(installation.buildReceiptId);
  const buildReceiptDigest = match(installation.buildReceiptDigest, SHA256, "build receipt digest");
  const agentVersionId = catalogId(installation.agentVersionId);
  const version = requireRecord(versions, agentVersionId, "Agent version");
  if (version.agent !== agent || version.state !== "APPROVED" || version.signatureVerified !== true
    || version.scan !== "PASS") invalid("Agent version supply-chain authority is not approved");
  const exactAgentVersion = exactVersion(version.version);
  if (/(^|[-_.])(latest|stable|default)(?:$|[-_.])/i.test(exactAgentVersion)) {
    invalid("Floating Agent versions are not allowed");
  }
  const agentVersionSourceDigest = match(version.sourceDigest, SHA256, "Agent source digest");
  match(version.catalogReceiptDigest, SHA256, "catalog receipt digest");
  match(version.validationReceiptDigest, SHA256, "validation receipt digest");
  match(version.supplyChainEvidenceDigest, SHA256, "supply-chain evidence digest");

  const provider = requireRecord(providers, providerRevisionId, "provider");
  if (provider.agent !== agent || provider.state !== "ACTIVE"
    || provider.credentialVersionId !== credentialVersionId) invalid("Agent Provider is inactive or incompatible");
  const providerProtocol = agent === "claude-code" ? "anthropic-messages" : "openai-responses";
  if (provider.protocol !== providerProtocol) invalid("Agent Provider protocol is incompatible");
  const providerBaseUrl = text(provider.baseUrl, 1_000);
  const providerApprovedPorts = approvedPorts(provider.approvedPorts);
  validateProviderBaseUrl(providerBaseUrl, { approvedPorts: providerApprovedPorts });
  const canonicalProviderBaseUrl = new URL(providerBaseUrl).toString();
  if (canonicalProviderBaseUrl !== providerBaseUrl) invalid("Agent Provider Base URL is not canonical");
  const providerAuthentication = authentication(provider.authentication, agent);
  const probe = object(provider.probe, "provider probe");
  for (const capability of [
    "authentication", "modelExistence", "streaming", "toolCalling", "cancellation",
    "usage", "timeout", "minimalReasoning", "dnsPinning", "redirectRevalidation",
  ]) {
    if (probe[capability] !== "PASS") invalid("Agent Provider probe is incomplete");
  }
  const models = object(provider.models, "model roles");
  const modelRoles = Object.freeze({
    primaryModel: pinned(models.primaryModel),
    planningModel: pinned(models.planningModel),
    smallFastModel: pinned(models.smallFastModel),
    subagentModel: pinned(models.subagentModel),
  });
  const pricingValue = object(provider.pricing, "provider pricing");
  const providerPricing = Object.freeze({
    inputUsdPerMillionTokens: nonNegativeDecimal(pricingValue.inputUsdPerMillionTokens, 1_000_000),
    outputUsdPerMillionTokens: nonNegativeDecimal(pricingValue.outputUsdPerMillionTokens, 1_000_000),
  });
  const governanceValue = object(provider.governance, "provider governance");
  const confirmedAt = text(governanceValue.confirmedAt, 80);
  if (!Number.isFinite(Date.parse(confirmedAt)) || new Date(confirmedAt).toISOString() !== confirmedAt) {
    invalid("Provider governance confirmation is invalid");
  }
  const providerGovernance = Object.freeze({
    dataRegion: text(governanceValue.dataRegion, 120),
    retentionPolicy: text(governanceValue.retentionPolicy, 500),
    trainingPolicy: text(governanceValue.trainingPolicy, 500),
    confirmedBy: text(governanceValue.confirmedBy, 160),
    confirmedAt: new Date(confirmedAt).toISOString(),
  });
  const credential = requireRecord(credentials, credentialVersionId, "credential");
  if (credential.state !== "ACTIVE") invalid("Agent credential version is inactive");
  const credentialScopeAllowed = profileScope === "platform"
    ? credential.scope === "platform" && credential.scopeId === "global"
    : credential.scope === "tenant" && credential.scopeId === input.tenantId;
  if (!credentialScopeAllowed) invalid("Agent credential version belongs to another tenant scope");
  const budgetValue = object(profile.budget, "profile budget");
  const budget = Object.freeze({
    maxUsd: decimal(budgetValue.maxUsd, 0, 100),
    maxTurns: integer(budgetValue.maxTurns, 1, 200),
    timeoutSeconds: integer(budgetValue.timeoutSeconds, 60, 14_400),
  });
  return Object.freeze({
    profileRevisionId: safeId(profile.id),
    agent,
    installationId,
    workerPool,
    imageDigest,
    workerImageId,
    adapterVersion,
    buildReceiptId,
    buildReceiptDigest,
    agentVersionId,
    exactAgentVersion,
    agentVersionSourceDigest,
    providerRevisionId,
    providerProtocol,
    providerBaseUrl: canonicalProviderBaseUrl,
    providerApprovedPorts,
    providerAuthentication,
    providerPricing,
    providerGovernance,
    modelRoles,
    credentialVersionId,
    budget,
  });
}

function selectableProfileScope(
  profile: Readonly<Record<string, unknown>>,
  selectedDefault: string,
  tenantId: string,
  projectId: string,
): "platform" | "tenant" | "project" {
  const scope = profile.scope;
  const scopeId = profile.scopeId;
  const platformProfile = scope === "platform" && scopeId === "global";
  const tenantProfile = scope === "tenant" && scopeId === tenantId;
  const projectProfile = scope === "project" && scopeId === projectId;
  const allowed = selectedDefault === "platform"
    ? platformProfile
    : selectedDefault.startsWith("tenant:")
      ? platformProfile || tenantProfile
      : platformProfile || tenantProfile || projectProfile;
  if (!allowed) invalid("Selected Agent Profile is inactive or belongs to another scope");
  return scope as "platform" | "tenant" | "project";
}

function index(value: unknown, label: string): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  if (!Array.isArray(value) || value.length > 100_000) invalid(`Administrator ${label} records are invalid`);
  const result = new Map<string, Readonly<Record<string, unknown>>>();
  for (const entry of value) {
    const record = object(entry, label);
    const id = catalogId(record.id);
    if (result.has(id)) invalid(`Administrator ${label} ID is duplicated`);
    result.set(id, record);
  }
  return result;
}
function defaultIndex(value: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(value) || value.length > 300_000) invalid("Administrator defaults are invalid");
  const result = new Map<string, string>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") invalid("Administrator default is invalid");
    const scope = entry[0];
    if (scope !== "platform" && !/^(tenant|project):[a-f0-9-]{36}$/i.test(scope)) invalid("Administrator default scope is invalid");
    if (result.has(scope)) invalid("Administrator default scope is duplicated");
    result.set(scope, safeId(entry[1]));
  }
  return result;
}
function requireRecord(map: ReadonlyMap<string, Readonly<Record<string, unknown>>>, id: unknown, label: string) {
  const record = map.get(catalogId(id));
  if (!record) invalid(`Selected ${label} revision is missing`);
  return record;
}
function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} is invalid`);
  return value as Readonly<Record<string, unknown>>;
}
function safeId(value: unknown): string { return match(value, SAFE_ID, "identifier"); }
function catalogId(value: unknown): string { return match(value, CATALOG_ID, "catalog identifier"); }
function exactVersion(value: unknown): string { return match(value, EXACT_VERSION, "exact version"); }
function match(value: unknown, pattern: RegExp, label: string): string {
  const selected = text(value, 512);
  if (!pattern.test(selected)) invalid(`${label} is invalid`);
  return selected;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r\n]/.test(value)) invalid("Text value is invalid");
  return value;
}
function pinned(value: unknown): string { return assertPinnedModelId(text(value, 200)); }
function agentKind(value: unknown): AgentKind {
  if (value !== "claude-code" && value !== "codex-cli") invalid("Agent kind is invalid");
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) invalid("Integer value is invalid");
  return value;
}
function decimal(value: unknown, minimumExclusive: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= minimumExclusive || value > maximum) invalid("Decimal value is invalid");
  return value;
}
function nonNegativeDecimal(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) invalid("Decimal value is invalid");
  return value;
}
function approvedPorts(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 443) invalid("Provider approved ports require a trusted Connector");
  return Object.freeze([443]);
}
function authentication(
  value: unknown,
  agent: AgentKind,
): ResolvedCatalogConfiguration["providerAuthentication"] {
  if (agent === "codex-cli" && value === "bearer") return value;
  if (agent === "claude-code" && (value === "x-api-key" || value === "authorization-bearer")) return value;
  invalid("Agent Provider authentication is incompatible");
}
function integerString(value: string | number | bigint): string {
  const selected = String(value);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(selected)) invalid("Catalog revision is invalid");
  return selected;
}
function invalid(message: string): never { throw new Error(message); }
