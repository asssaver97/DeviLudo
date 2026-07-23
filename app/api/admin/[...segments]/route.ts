import { normalizeModelRoles } from "@/lib/agent/providers";
import {
  builtInAdapterVersion,
  exactAdapterCompatibility,
  isAdapterVersionAttested,
  isBuiltInAdapterVersion,
} from "@/lib/agent/adapter-registry";
import { AGENT_REGISTRY, AGENT_REGISTRY_SCHEMA_VERSION } from "@/lib/agent/registry";
import { localWorkerImageDigest } from "@/lib/agent/local-worker-identity";
import { adminControlPlaneBrokerFromEnvironment, resolveAdminControlPlanePath } from "@/lib/admin/control-plane-broker";
import { verifyTrustedAdminPrincipal } from "@/lib/admin/trusted-principal";
import {
  activateLocalProviderBinding,
  disableLocalProviderBinding,
  localProviderControlRequired,
  probeLocalProvider,
  putLocalProviderCredential,
  revokeLocalProviderCredential,
} from "@/lib/admin/local-provider-control";
import {
  appendDemoAudit,
  getDemoStore,
  withIdempotency,
  type DemoAuditEvent,
  type DemoCredential,
  type DemoInstallation,
  type DemoProfile,
  type DemoProvider,
  type DemoStoreState,
} from "@/lib/control-plane/demo-store";
import {
  acquireLocalAdminState,
  type LocalAdminStateLease,
} from "@/lib/control-plane/local-admin-state";
import {
  assertAllowedBodyFields,
  bodyObject,
  HttpProblem,
  idempotencyKey,
  json,
  problemResponse,
  requireRole,
  requireString,
} from "@/lib/control-plane/http";
import { fingerprintSecret, maskFingerprint } from "@/lib/security/credentials";
import { validateProviderBaseUrl } from "@/lib/security/network";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

type RouteContext = { params: Promise<{ segments: string[] }> };
const VERSION_ROLES = ["PlatformAgentAdmin"] as const;
const SECURITY_ROLES = ["SecurityAdmin"] as const;
const PROFILE_ROLES = ["PlatformAgentAdmin", "SecurityAdmin", "TenantAdmin", "ProjectOwner"] as const;
const LOCAL_ROLES = ["PlatformAgentAdmin", "SecurityAdmin", "TenantAdmin", "ProjectOwner", "Auditor"] as const;
type LocalRole = typeof LOCAL_ROLES[number];
type LocalActor = Readonly<{ role: LocalRole; actorId: string; tenantId: string | null; projectId: string | null }>;
const EXACT_AGENT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOCAL_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const PROVIDER_REQUIRED_CHECKS = Object.freeze([
  "authentication", "modelExistence", "streaming", "toolCalling", "cancellation",
  "usage", "timeout", "minimalReasoning", "dnsPinning", "redirectRevalidation",
] as const);
const PROFILE_DRAFT_FIELDS = Object.freeze([
  "agent", "installationId", "credentialVersionId", "scope", "scopeId", "baseUrl", "authentication",
  "primaryModel", "planningModel", "smallFastModel", "subagentModel",
  "inputUsdPerMillionTokens", "outputUsdPerMillionTokens",
  "dataRegion", "retentionPolicy", "trainingPolicy",
  "maxBudgetUsd", "maxTurns", "timeoutSeconds", "fallbackProfileRevisionId",
]);

function defaultAgent() {
  const store = getDemoStore();
  const profile = store.profiles.find((item) => item.id === store.defaults.platform && item.state === "ACTIVE");
  return profile?.agent ?? "claude-code";
}

function agentCatalog() {
  const store = getDemoStore();
  const selected = defaultAgent();
  return (["claude-code", "codex-cli"] as const).map((agent) => ({
    registrySchemaVersion: AGENT_REGISTRY_SCHEMA_VERSION,
    id: agent,
    name: AGENT_REGISTRY[agent].displayName,
    vendor: AGENT_REGISTRY[agent].vendor,
    officialSource: AGENT_REGISTRY[agent].officialSource,
    adapterId: AGENT_REGISTRY[agent].adapterId,
    adapterVersion: AGENT_REGISTRY[agent].adapterVersion,
    providerProtocol: AGENT_REGISTRY[agent].providerProtocol,
    configurationSchema: AGENT_REGISTRY[agent].configurationSchema,
    capabilities: AGENT_REGISTRY[agent].capabilities,
    supportedWorkers: AGENT_REGISTRY[agent].supportedWorkerPlatforms,
    installedOn: AGENT_REGISTRY[agent].installedOn,
    forbiddenOn: AGENT_REGISTRY[agent].forbiddenOn,
    default: selected === agent,
    approvedVersions: Object.entries(store.agentVersions)
      .filter(([key, state]) => key.startsWith(`${agent}@`) && state === "APPROVED")
      .map(([key]) => key.split("@")[1]),
  }));
}

function localActor(request: Request, expectedRole?: string): LocalActor {
  const roleValue = expectedRole ?? request.headers.get("x-deviludo-role") ?? "Auditor";
  if (!LOCAL_ROLES.includes(roleValue as LocalRole)) {
    throw new HttpProblem(403, "FORBIDDEN", "Local Agent role is not allowed");
  }
  const role = roleValue as LocalRole;
  const tenantId = localScopeHeader(request, "x-deviludo-tenant-id");
  const projectId = localScopeHeader(request, "x-deviludo-project-id");
  if (role === "TenantAdmin" && !tenantId) {
    throw new HttpProblem(403, "TENANT_SCOPE_REQUIRED", "TenantAdmin requests require an authenticated tenant scope");
  }
  if (role === "ProjectOwner" && (!tenantId || !projectId)) {
    throw new HttpProblem(403, "PROJECT_SCOPE_REQUIRED", "ProjectOwner requests require authenticated tenant and project scopes");
  }
  if (projectId && !tenantId) {
    throw new HttpProblem(403, "TENANT_SCOPE_REQUIRED", "A project scope cannot exist without its tenant scope");
  }
  const actorId = request.headers.get("x-deviludo-actor-id")?.trim() || role;
  return Object.freeze({ role, actorId, tenantId, projectId });
}

function localScopeHeader(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim() ?? "";
  if (!value) return null;
  if (!LOCAL_SCOPE_ID.test(value)) throw new HttpProblem(403, "INVALID_SCOPE", `Invalid ${name} binding`);
  return value;
}

function localAgentProjection(store: DemoStoreState, actor: LocalActor) {
  const unrestricted = actor.role === "PlatformAgentAdmin" || actor.role === "SecurityAdmin"
    || (actor.role === "Auditor" && !actor.tenantId);
  const profiles = unrestricted ? store.profiles : store.profiles.filter((profile) => {
    if (profile.scope === "platform") return profile.state === "ACTIVE";
    if (profile.scope === "tenant") return Boolean(actor.tenantId && profile.scopeId === actor.tenantId);
    return Boolean(actor.projectId && profile.scopeId === actor.projectId);
  });
  const visibleProfileIds = new Set(profiles.map((profile) => profile.id));
  const visibleProviderIds = new Set(profiles.map((profile) => profile.providerRevisionId));
  const credentialLastUsedAt = localCredentialLastUsedAt(store);
  const credentials = store.credentials.filter((credential) => unrestricted
    || actor.role === "TenantAdmin" && credential.scope === "tenant" && credential.scopeId === actor.tenantId);
  const defaults = Object.fromEntries(Object.entries(store.defaults).filter(([scope, profileId]) =>
    localDefaultVisible(scope, actor, unrestricted) && visibleProfileIds.has(profileId)));
  return {
    providers: store.providers.filter((provider) => unrestricted || visibleProviderIds.has(provider.id)),
    profiles,
    credentials: credentials.map(({ id, familyId, label, scope, scopeId, masked, version, state, createdAt, rotatedAt }) => ({
      id, familyId, label, scope, scopeId, maskedFingerprint: masked, version, state, createdAt, rotatedAt,
      lastUsedAt: credentialLastUsedAt[id] ?? null,
      plaintextRecoverable: false,
    })),
    defaults,
  };
}

function localDefaultVisible(scope: string, actor: LocalActor, unrestricted: boolean): boolean {
  if (unrestricted) return true;
  if (scope === "platform") return true;
  if (scope === `tenant:${actor.tenantId}`) return true;
  return Boolean(actor.projectId && scope === `project:${actor.projectId}`);
}

function assertLocalProfileActor(actor: LocalActor, scope: DemoProfile["scope"], scopeId: string): void {
  if (actor.role === "SecurityAdmin") return;
  if (actor.role === "PlatformAgentAdmin" && scope === "platform" && scopeId === "global") return;
  if (actor.role === "TenantAdmin" && scope === "tenant" && actor.tenantId === scopeId) return;
  if (actor.role === "ProjectOwner" && scope === "project" && actor.projectId === scopeId && actor.tenantId) return;
  throw new HttpProblem(403, "SCOPE_FORBIDDEN", `Role ${actor.role} cannot administer ${scope} Agent configuration`);
}

function assertLocalProfileCredential(
  actor: LocalActor,
  scope: DemoProfile["scope"],
  scopeId: string,
  credential: DemoCredential,
): void {
  const allowed = scope === "platform"
    ? credential.scope === "platform" && credential.scopeId === "global"
    : scope === "tenant"
      ? credential.scope === "tenant" && credential.scopeId === scopeId
      : credential.scope === "tenant" && credential.scopeId === actor.tenantId;
  if (!allowed) {
    throw new HttpProblem(403, "CREDENTIAL_SCOPE_FORBIDDEN", "Profile cannot use a credential from another scope");
  }
}

function assertLocalCredentialActor(actor: LocalActor, credential: DemoCredential): void {
  if (actor.role === "SecurityAdmin") return;
  if (actor.role === "TenantAdmin" && credential.scope === "tenant" && credential.scopeId === actor.tenantId) return;
  throw new HttpProblem(403, "CREDENTIAL_SCOPE_FORBIDDEN", "Credential does not belong to the authenticated scope");
}

function assertLocalDefaultActor(actor: LocalActor, scope: DemoProfile["scope"], scopeId: string): void {
  if (actor.role === "SecurityAdmin") return;
  if (scope === "platform" && actor.role === "PlatformAgentAdmin" && scopeId === "global") return;
  if (scope === "tenant" && actor.role === "TenantAdmin" && actor.tenantId === scopeId) return;
  if (scope === "project" && actor.role === "ProjectOwner" && actor.projectId === scopeId && actor.tenantId) return;
  throw new HttpProblem(403, "SCOPE_FORBIDDEN", `Role ${actor.role} cannot update ${scope}:${scopeId}`);
}

function localOperationalProjection(store: DemoStoreState) {
  const windowStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const records = store.usage.filter((record) => record.recordedAt >= windowStartedAt).slice(0, 50);
  const totals = records.reduce((summary, record) => ({
    requests: summary.requests + 1,
    inputTokens: summary.inputTokens + record.inputTokens,
    outputTokens: summary.outputTokens + record.outputTokens,
    costUsd: summary.costUsd + record.costUsd,
  }), { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const alerts: Array<{ id: string; severity: "WARNING" | "CRITICAL"; code: string; resource: string; message: string }> = [];
  const addAlert = (severity: "WARNING" | "CRITICAL", code: string, resource: string, message: string) => {
    alerts.push({ id: `${code}:${resource}`, severity, code, resource, message });
  };
  for (const installation of store.installations) {
    if (["FAILED", "QUARANTINED"].includes(installation.state)) {
      addAlert("CRITICAL", "AGENT_INSTALLATION_UNSERVABLE", installation.id, `安装处于 ${installation.state}，新任务不会分配`);
    } else if (installation.state === "ACTIVE" && installation.health !== "HEALTHY") {
      addAlert("CRITICAL", "ACTIVE_INSTALLATION_UNHEALTHY", installation.id, `活跃安装健康状态为 ${installation.health}`);
    }
  }
  for (const provider of store.providers) {
    if (provider.state === "DISABLED") continue;
    if (Object.values(provider.probe).some((result) => result === "FAIL")) {
      addAlert("CRITICAL", "PROVIDER_PROBE_FAILED", provider.id, "Provider 的认证、模型或网络安全探针未全部通过");
    }
  }
  for (const profile of store.profiles.filter((item) => item.state === "ACTIVE")) {
    const installation = store.installations.find((item) => item.id === profile.installationId);
    const provider = store.providers.find((item) => item.id === profile.providerRevisionId);
    if (!installation || installation.state !== "ACTIVE" || installation.health !== "HEALTHY") {
      addAlert("CRITICAL", "PROFILE_INSTALLATION_BINDING_UNAVAILABLE", profile.id, "活跃 Profile 绑定的精确 WorkerImage 当前不可服务");
    }
    if (!installation || !["APPROVED", "DEPRECATED"].includes(store.agentVersions[`${installation.agent}@${installation.version}`])) {
      addAlert("CRITICAL", "PROFILE_VERSION_BINDING_UNAVAILABLE", profile.id, "活跃 Profile 绑定的 Agent 版本已被阻止或缺少供应链授权");
    }
    if (!provider || provider.state !== "ACTIVE" || profile.credentialVersionId !== provider.credentialVersionId
      || !providerConfigurationComplete(provider)
      || Object.values(provider.probe).some((result) => result !== "PASS")) {
      addAlert("CRITICAL", "PROFILE_PROVIDER_BINDING_UNAVAILABLE", profile.id, "活跃 Profile 绑定的 Provider revision 当前不可服务");
    }
  }
  return {
    usage: {
      available: true,
      source: "inference_usage_events",
      windowStartedAt,
      credentialLastUsedAt: localCredentialLastUsedAt(store),
      totals: { ...totals, costUsd: Number(totals.costUsd.toFixed(10)) },
      records,
    },
    configurationDiffs: store.audit.map(localConfigurationDiff).filter((item) => item !== null).slice(0, 50),
    alerts,
  };
}

function localCredentialLastUsedAt(store: DemoStoreState): Readonly<Record<string, string>> {
  const projection: Record<string, string> = {};
  for (const record of [...store.usage].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))) {
    projection[record.credentialVersionId] ??= record.recordedAt;
  }
  return Object.freeze(projection);
}

function localConfigurationDiff(record: DemoAuditEvent) {
  if (!/^(AGENT_(VERSION|INSTALLATION|PROFILE|DEFAULT)|ROLLOUT_|CREDENTIAL_)/.test(record.action)) return null;
  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  appendLocalDiff(changes, record.metadata, "state", "previousState", "state");
  appendLocalDiff(changes, record.metadata, "providerState", "previousProviderState", "providerState");
  appendLocalDiff(changes, record.metadata, "rolloutPercent", "previousRolloutPercent", "rolloutPercent");
  appendLocalDiff(changes, record.metadata, "profileRevisionId", "previousProfileRevisionId", "profileRevisionId");
  if (/CREDENTIAL_ROTATE/.test(record.action) && typeof record.metadata.replacementVersionId === "string") {
    changes.push({ field: "credentialVersionId", before: record.resource, after: record.metadata.replacementVersionId });
  }
  if (changes.length === 0 && /(CREATED|DRAFTED|DISCOVERED|READY)$/.test(record.action)) {
    changes.push({ field: "resource", before: null, after: record.resource });
  }
  return changes.length ? { id: record.id, action: record.action, resource: record.resource, actorId: record.actor, at: record.at, changes } : null;
}

function appendLocalDiff(
  target: Array<{ field: string; before: unknown; after: unknown }>,
  metadata: Readonly<Record<string, unknown>>,
  field: string,
  beforeKey: string,
  afterKey: string,
) {
  if (!(beforeKey in metadata) || !(afterKey in metadata) || metadata[beforeKey] === metadata[afterKey]) return;
  target.push({ field, before: metadata[beforeKey], after: metadata[afterKey] });
}

function routeKey(segments: string[]): string {
  return segments.join("/");
}

function officialPackageSource(agent: "claude-code" | "codex-cli", version: string): string {
  return agent === "claude-code"
    ? `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`
    : `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`;
}

function officialReleaseNotes(agent: "claude-code" | "codex-cli"): string {
  return agent === "claude-code"
    ? "https://github.com/anthropics/claude-code/releases"
    : "https://github.com/openai/codex/releases";
}

export async function GET(request: Request, context: RouteContext) {
  let lease: LocalAdminStateLease | null = null;
  try {
    const { segments } = await context.params;
    if (!isLoopbackTestRequest(request)) return productionAdminRequest(request, segments);
    requireLocalAdmin(request);
    lease = await acquireLocalAdminState();
    const key = routeKey(segments);
    const store = getDemoStore();
    if (key === "agents") {
      const actor = localActor(request);
      const projection = localAgentProjection(store, actor);
      return json({
        data: agentCatalog(),
        meta: {
          defaultAgent: defaultAgent(),
          revisionPolicy: "pinned-only",
          versions: Object.entries(store.agentVersions).map(([id, state]) => {
            const separator = id.lastIndexOf("@");
            return { id, agent: id.slice(0, separator), version: id.slice(separator + 1), state, ...store.agentVersionMetadata[id] };
          }),
          installations: store.installations,
          rollouts: store.rollouts,
          providers: projection.providers,
          profiles: projection.profiles,
          credentials: projection.credentials,
          defaults: projection.defaults,
        },
      }, { headers: { "x-deviludo-effective-role": request.headers.get("x-deviludo-role") ?? "Auditor",
        "x-deviludo-admin-auth-mode": "local-fixture" } });
    }
    if (key === "agent-health") {
      const operations = localOperationalProjection(store);
      return json({
        data: {
          status: operations.alerts.length > 0 ? "DEGRADED" : "HEALTHY",
          installations: store.installations,
          providers: store.providers.map(({ id, state, probe }) => ({ id, state, probe })),
          isolation: { developmentWorkers: true, e2eRunnersContainAgent: false, steamPublishersContainAgent: false },
          supplyChain: {
            service: "deviludo-agent-supply-chain",
            version: "0.1.0-local",
            binaryDigest: "0".repeat(64),
            status: "READY",
            checkedAt: new Date().toISOString(),
            mode: "LOCAL_DETERMINISTIC_BROKER",
            acceptsCallerAttestations: false,
          },
          ...operations,
          checkedAt: new Date().toISOString(),
        },
      });
    }
    if (key === "audit") {
      return json({ data: store.audit, meta: { appendOnly: true, redacted: true } });
    }
    if (/^inference-runs\/[a-f0-9-]+\/[a-f0-9-]+\/reconciliation$/i.test(key)) {
      requireRole(request, SECURITY_ROLES);
      throw new HttpProblem(
        503,
        "INFERENCE_RECONCILIATION_GATEWAY_REQUIRED",
        "本地测试站未连接受信 mTLS Inference Gateway，不能读取真实未决账单请求",
      );
    }
    if (/^spec-model-generations\/[a-f0-9-]+\/[a-f0-9]{64}\/reconciliation$/i.test(key)) {
      requireRole(request, SECURITY_ROLES);
      throw new HttpProblem(
        503,
        "SPEC_MODEL_RECONCILIATION_BROKER_REQUIRED",
        "本地测试站不会伪造规格模型上游账单状态；请配置生产控制面与独立 mTLS 对账角色",
      );
    }
    throw new HttpProblem(404, "NOT_FOUND", `Unknown admin resource: ${key}`);
  } catch (error) {
    return problemResponse(error);
  } finally {
    lease?.release();
  }
}

export async function POST(request: Request, context: RouteContext) {
  let lease: LocalAdminStateLease | null = null;
  try {
    const { segments } = await context.params;
    if (!isLoopbackTestRequest(request)) return productionAdminRequest(request, segments);
    requireLocalAdmin(request);
    lease = await acquireLocalAdminState();
    const key = routeKey(segments);
    const body = await bodyObject(request);
    const idempotency = idempotencyKey(request);

    if (key === "agent-versions/discover") {
      const role = requireRole(request, VERSION_ROLES);
      assertAllowedBodyFields(body, ["agent", "version"]);
      const agent = body.agent ?? "claude-code";
      if (agent !== "claude-code" && agent !== "codex-cli") {
        throw new HttpProblem(400, "INVALID_AGENT", "Version discovery supports only Claude Code or Codex CLI");
      }
      const version = body.version === undefined
        ? agent === "claude-code" ? "2.1.15" : "0.92.0"
        : requireString(body, "version", 120);
      if (!EXACT_AGENT_VERSION.test(version) || /latest|stable|default/i.test(version)) {
        throw new HttpProblem(400, "INVALID_AGENT_VERSION", "Version discovery requires an exact non-floating version");
      }
      const id = `${agent}@${version}`;
      const source = officialPackageSource(agent, version);
      const sourceDigest = await fingerprintSecret(new TextEncoder().encode(`local-agent-source:v1:${source}`));
      const discoveredAt = new Date().toISOString();
      return await mutate(lease, `admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        store.agentVersions[id] ??= "DISCOVERED";
        store.agentVersionMetadata[id] ??= {
          source,
          sourceDigest,
          releaseNotesUrl: officialReleaseNotes(agent),
          discoveredAt,
          integrity: null,
          signatureVerified: false,
          sbomRef: null,
          scan: "PENDING",
          validationReceiptId: null,
          validationReceiptDigest: null,
          supplyChainEvidenceDigest: null,
          validatedAdapterVersion: null,
          adapterCompatibility: null,
          validatedAt: null,
        };
        appendDemoAudit("AGENT_VERSION_DISCOVERED", id, role, {
          source: "official-npm-registry",
          sourceDigest: store.agentVersionMetadata[id].sourceDigest,
          automaticActivation: false,
        });
        return { candidates: [{ id, agent, version, state: store.agentVersions[id], ...store.agentVersionMetadata[id], activated: false }] };
      });
    }

    if (key === "agent-versions/approve" || key === "agent-versions/block" || key === "agent-versions/deprecate") {
      const role = requireRole(request, VERSION_ROLES);
      const id = requireString(body, "id", 120);
      const state = key.endsWith("approve") ? "APPROVED" as const
        : key.endsWith("deprecate") ? "DEPRECATED" as const : "BLOCKED" as const;
      const forbiddenAttestationFields = [
        "integrity", "signatureVerified", "scan", "sbomRef", "sourceDigest", "validationReceipt",
        "validationReceiptId", "validationReceiptDigest", "supplyChainEvidenceDigest", "validatedAdapterVersion",
        "adapterCompatibility", "validatedAt", "imageDigest",
      ];
      if (state === "APPROVED" && forbiddenAttestationFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
        throw new HttpProblem(400, "CALLER_ATTESTATION_FORBIDDEN", "签名、扫描、SBOM 与 digest 只能来自受信供应链 Broker，不能由管理员请求提供");
      }
      assertAllowedBodyFields(body, ["id"]);
      const approvalAgent = id.startsWith("claude-code@") ? "claude-code" : "codex-cli";
      const approvalAdapterVersion = builtInAdapterVersion(approvalAgent);
      const approvalAdapterCompatibility = exactAdapterCompatibility(approvalAdapterVersion);
      const [receiptDigest, integrityDigest, evidenceDigest] = state === "APPROVED"
        ? await Promise.all([
          fingerprintSecret(new TextEncoder().encode(
            `local-agent-validation:v2:${id}:${approvalAdapterVersion}:${approvalAdapterCompatibility.min}:${approvalAdapterCompatibility.maxExclusive}`,
          )),
          fingerprintSecret(new TextEncoder().encode(`local-agent-integrity:v1:${id}`)),
          fingerprintSecret(new TextEncoder().encode(
            `local-agent-evidence:v2:${id}:${approvalAdapterVersion}:${approvalAdapterCompatibility.min}:${approvalAdapterCompatibility.maxExclusive}`,
          )),
        ])
        : [null, null, null];
      return await mutate(lease, `admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        if (!(id in store.agentVersions)) throw new HttpProblem(404, "VERSION_NOT_FOUND", "Agent version was not discovered");
        if (state === "APPROVED" && store.agentVersions[id] !== "DISCOVERED") {
          throw new HttpProblem(409, "INVALID_VERSION_TRANSITION", "Only a discovered version can be approved");
        }
        if (state === "DEPRECATED" && store.agentVersions[id] !== "APPROVED") {
          throw new HttpProblem(409, "INVALID_VERSION_TRANSITION", "Only an approved version can be deprecated");
        }
        if (state === "BLOCKED" && !["DISCOVERED", "VALIDATING", "APPROVED", "DEPRECATED"].includes(store.agentVersions[id])) {
          throw new HttpProblem(409, "INVALID_VERSION_TRANSITION", "This Agent version cannot transition to blocked");
        }
        const previousState = store.agentVersions[id];
        store.agentVersions[id] = state;
        if (state === "APPROVED" && receiptDigest && integrityDigest && evidenceDigest) {
          const metadata = store.agentVersionMetadata[id];
          if (!metadata) throw new HttpProblem(409, "VERSION_METADATA_NOT_FOUND", "Agent version source metadata is unavailable");
          Object.assign(metadata, {
            integrity: integrityDigest,
            signatureVerified: true,
            sbomRef: `urn:deviludo:local-sbom:${id.replaceAll("@", ":")}`,
            scan: "PASS",
            validationReceiptId: `local-validation-${id.replaceAll("@", "-")}`,
            validationReceiptDigest: receiptDigest,
            supplyChainEvidenceDigest: evidenceDigest,
            validatedAdapterVersion: approvalAdapterVersion,
            adapterCompatibility: approvalAdapterCompatibility,
            validatedAt: new Date().toISOString(),
          });
        }
        appendDemoAudit(`AGENT_VERSION_${state}`, id, role, {
          previousState,
          state,
          automaticActivation: false,
          newInstallationsAllowed: false,
          trustBoundary: "LOCAL_DETERMINISTIC_BROKER",
          ...(receiptDigest ? { validationReceiptDigest: receiptDigest } : {}),
          ...(state === "APPROVED" ? {
            validatedAdapterVersion: approvalAdapterVersion,
          } : {}),
        });
        return {
          id,
          state,
          immutable: true,
          activationRequired: state === "APPROVED",
          ...(state === "DEPRECATED" ? { existingInstallationsAffected: false } : {}),
          ...(receiptDigest ? { validationReceiptId: `local-validation-${id.replaceAll("@", "-")}`, validationReceiptDigest: receiptDigest } : {}),
        };
      });
    }

    if (key === "agent-installations") {
      const role = requireRole(request, VERSION_ROLES);
      const version = requireString(body, "version", 120);
      const agent = requireString(body, "agent", 32);
      const workerPool = requireString(body, "workerPool", 120);
      const adapterVersion = requireString(body, "adapterVersion", 120);
      if ([
        "imageDigest", "workerImageId", "buildReceipt", "buildReceiptId", "buildReceiptDigest",
        "supplyChainEvidenceDigest", "selfUpdateDisabled", "stages",
      ].some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
        throw new HttpProblem(400, "CALLER_ATTESTATION_FORBIDDEN", "WorkerImage digest 与构建回执只能来自受信供应链 Broker");
      }
      assertAllowedBodyFields(body, ["agent", "version", "workerPool", "adapterVersion"]);
      if ((agent !== "claude-code" && agent !== "codex-cli") || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(version)
        || !/^dev(?:elopment)?[-_a-z0-9]*$/i.test(workerPool) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(adapterVersion)) {
        throw new HttpProblem(400, "INVALID_INSTALLATION", "Agent and version must be exact supported identifiers");
      }
      const agentKind = agent as "claude-code" | "codex-cli";
      if (!isBuiltInAdapterVersion(agentKind, adapterVersion)) {
        throw new HttpProblem(409, "ADAPTER_NOT_APPROVED", "Adapter 版本未被不可变 Agent Registry 批准");
      }
      if (getDemoStore().agentVersions[`${agentKind}@${version}`] !== "APPROVED") {
        throw new HttpProblem(409, "VERSION_NOT_APPROVED", "Only a Broker-attested approved version can build a WorkerImage");
      }
      const versionMetadata = getDemoStore().agentVersionMetadata[`${agentKind}@${version}`];
      if (!versionMetadata?.validatedAdapterVersion || !versionMetadata.adapterCompatibility) {
        throw new HttpProblem(409, "VERSION_ADAPTER_COMPATIBILITY_UNATTESTED", "Agent 版本必须重新通过 Adapter 契约验证后才能创建新安装");
      }
      if (!isAdapterVersionAttested(adapterVersion, versionMetadata.validatedAdapterVersion, versionMetadata.adapterCompatibility)) {
        throw new HttpProblem(409, "VERSION_ADAPTER_INCOMPATIBLE", "Agent 版本验证回执不覆盖请求的 Adapter 版本");
      }
      const versionSlug = version.replaceAll(".", "").replaceAll("-", "");
      const identityDigest = await fingerprintSecret(new TextEncoder().encode(
        `local-installation-identity:v3:${agentKind}:${version}:${adapterVersion}:${workerPool}:${idempotency}`,
      ));
      const id = `${agentKind === "claude-code" ? "claude" : "codex"}-installation-${versionSlug}-${identityDigest.slice(7, 23)}`;
      const imageDigest = await localWorkerImageDigest(agentKind, version, adapterVersion);
      const buildReceiptDigest = await fingerprintSecret(new TextEncoder().encode(`local-build-receipt:v1:${id}:${imageDigest}:${workerPool}`));
      return await mutate(lease, `admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        const rollbackInstallationId = selectDemoRollbackInstallation(store, agentKind, workerPool)?.id ?? null;
        const installation = {
          id,
          agent: agentKind,
          version,
          workerPool,
          adapterVersion,
          imageDigest,
          buildReceiptId: `local-build-${id}`,
          buildReceiptDigest,
          state: "READY",
          health: "HEALTHY" as const,
          rolloutPercent: 0 as const,
          rollbackInstallationId,
          createdAt: new Date().toISOString(),
          activatedAt: null,
          drainingAt: null,
          retiredAt: null,
        };
        const current = store.installations.findIndex((item) => item.id === id);
        if (current >= 0) {
          const existing = store.installations[current];
          if (existing?.buildReceiptDigest !== buildReceiptDigest) {
            throw new HttpProblem(409, "INSTALLATION_BUILD_DRIFT", "The immutable local WorkerImage already has a different build receipt");
          }
          return { ...existing, cliSelfUpdateDisabled: true };
        }
        store.installations.unshift(installation);
        store.rollouts[id] = { percent: 0, previous: 0, state: "READY" };
        appendDemoAudit("AGENT_INSTALLATION_CREATED", id, role, { imageDigest, workerPool, buildReceiptDigest, trustBoundary: "LOCAL_DETERMINISTIC_BROKER" });
        return { ...installation, cliSelfUpdateDisabled: true };
      });
    }

    const rolloutMatch = /^agent-rollouts\/([^/]+)\/(advance|rollback)$/.exec(key);
    if (rolloutMatch) {
      const role = requireRole(request, VERSION_ROLES);
      assertAllowedBodyFields(body, []);
      const installationId = rolloutMatch[1] ?? "";
      const action = rolloutMatch[2];
      return await mutate(lease, `admin:${key}:${idempotency}`, () => {
        const rollout = getDemoStore().rollouts[installationId];
        if (!rollout) throw new HttpProblem(404, "INSTALLATION_NOT_FOUND", "Installation does not exist");
        if (action === "rollback" && rollout.percent === 0) {
          throw new HttpProblem(409, "ROLLOUT_ALREADY_AT_TARGET", "Installation rollout is already at 0%");
        }
        if (action === "rollback") {
          rollout.previous = rollout.percent;
          rollout.percent = 0;
          rollout.state = "READY";
        } else {
          rollout.previous = rollout.percent;
          rollout.percent = rollout.percent < 5 ? 5 : rollout.percent < 25 ? 25 : 100;
          rollout.state = rollout.percent === 100 ? "ACTIVE" : "CANARY";
        }
        const installation = getDemoStore().installations.find((item) => item.id === installationId);
        if (installation) {
          installation.rolloutPercent = rollout.percent;
          installation.state = rollout.state;
          if (rollout.percent === 100) installation.activatedAt = new Date().toISOString();
        }
        const rollbackProfileRevisionIds = action === "rollback" && installation
          ? rollbackDemoProfiles(getDemoStore(), installation)
          : [];
        appendDemoAudit(`ROLLOUT_${action?.toUpperCase()}`, installationId, role, {
          previousRolloutPercent: rollout.previous,
          rolloutPercent: rollout.percent,
          ...(installation?.activatedAt ? { activatedAt: installation.activatedAt } : {}),
          affectsRunningTasks: false,
          rollbackProfileCount: rollbackProfileRevisionIds.length,
        });
        return { installationId, ...rollout, rollbackProfileRevisionIds, affectsNewTasksOnly: true };
      });
    }

    const lifecycleMatch = /^agent-installations\/([^/]+)\/(drain|retire)$/.exec(key);
    if (lifecycleMatch) {
      const role = requireRole(request, VERSION_ROLES);
      assertAllowedBodyFields(body, []);
      const installationId = lifecycleMatch[1] ?? "";
      const action = lifecycleMatch[2] as "drain" | "retire";
      return await mutate(lease, `admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        const installation = store.installations.find((item) => item.id === installationId);
        const rollout = store.rollouts[installationId];
        if (!installation || !rollout) throw new HttpProblem(404, "INSTALLATION_NOT_FOUND", "Installation does not exist");
        if (action === "drain") {
          if (installation.state !== "ACTIVE" || rollout.percent !== 100) {
            throw new HttpProblem(409, "INSTALLATION_NOT_DRAINABLE", "Only a fully active installation can begin draining");
          }
          const at = new Date().toISOString();
          const previousState = installation.state;
          rollout.previous = rollout.percent;
          rollout.percent = 0;
          rollout.state = "DRAINING";
          installation.rolloutPercent = 0;
          installation.state = "DRAINING";
          installation.drainingAt = at;
          const rollbackProfileRevisionIds = rollbackDemoProfiles(store, installation);
          appendDemoAudit("AGENT_INSTALLATION_DRAINING", installationId, role, {
            previousState,
            state: installation.state,
            affectsRunningTasks: false,
            rollbackProfileCount: rollbackProfileRevisionIds.length,
            drainingAt: at,
          });
          return { installation, rollbackProfileRevisionIds, affectsNewTasksOnly: true };
        }
        if (installation.state !== "DRAINING" || rollout.percent !== 0 || !installation.drainingAt) {
          throw new HttpProblem(409, "INSTALLATION_NOT_RETIRABLE", "Installation must finish draining before retirement");
        }
        const defaultScopes = Object.entries(store.defaults).filter(([, profileId]) =>
          demoProfileReferencesInstallation(store, profileId, installationId)).map(([scope]) => scope);
        if (defaultScopes.length > 0) {
          throw new HttpProblem(409, "INSTALLATION_DEFAULT_STILL_REFERENCED", "Move every effective default away from this installation before retirement");
        }
        const at = new Date().toISOString();
        const previousState = installation.state;
        rollout.state = "RETIRED";
        installation.state = "RETIRED";
        installation.retiredAt = at;
        appendDemoAudit("AGENT_INSTALLATION_RETIRED", installationId, role, {
          previousState, state: installation.state, activeRuns: 0, retiredAt: at,
        });
        return { installation, nonTerminalRuns: 0 };
      });
    }

    if (key === "agent-profiles") {
      const role = requireRole(request, PROFILE_ROLES);
      assertAllowedBodyFields(body, PROFILE_DRAFT_FIELDS);
      const agent = requireString(body, "agent", 32);
      if (agent !== "claude-code" && agent !== "codex-cli") throw new HttpProblem(400, "INVALID_AGENT", "Only claude-code and codex-cli are supported");
      const baseUrl = requireString(body, "baseUrl", 1000);
      try {
        validateProviderBaseUrl(baseUrl, { approvedPorts: [443] });
      } catch (error) {
        throw new HttpProblem(400, "PROVIDER_ENDPOINT_REJECTED", error instanceof Error ? error.message : "Provider endpoint is unsafe");
      }
      const primaryModel = requireString(body, "primaryModel", 200);
      let models;
      try {
        models = normalizeModelRoles({
          primaryModel,
          planningModel: optionalModel(body.planningModel),
          smallFastModel: optionalModel(body.smallFastModel),
          subagentModel: optionalModel(body.subagentModel),
        });
      } catch (error) {
        throw new HttpProblem(400, "MODEL_ID_REJECTED", error instanceof Error ? error.message : "Model IDs must be exact");
      }
      const protocol = agent === "codex-cli" ? "openai-responses" : "anthropic-messages";
      const authenticationValue = requireString(body, "authentication", 40);
      if ((agent === "codex-cli" && authenticationValue !== "bearer")
        || (agent === "claude-code" && authenticationValue !== "x-api-key" && authenticationValue !== "authorization-bearer")) {
        throw new HttpProblem(400, "PROVIDER_AUTHENTICATION_REJECTED", "Authentication is incompatible with the selected Agent protocol");
      }
      const authentication = authenticationValue as DemoProvider["authentication"];
      const inputUsdPerMillionTokens = body.inputUsdPerMillionTokens;
      const outputUsdPerMillionTokens = body.outputUsdPerMillionTokens;
      if (typeof inputUsdPerMillionTokens !== "number" || !Number.isFinite(inputUsdPerMillionTokens)
        || inputUsdPerMillionTokens < 0 || inputUsdPerMillionTokens > 1_000_000
        || typeof outputUsdPerMillionTokens !== "number" || !Number.isFinite(outputUsdPerMillionTokens)
        || outputUsdPerMillionTokens < 0 || outputUsdPerMillionTokens > 1_000_000) {
        throw new HttpProblem(400, "PROVIDER_PRICING_REJECTED", "Provider token pricing must be explicit non-negative USD per million tokens");
      }
      const credentialVersionId = requireString(body, "credentialVersionId", 160);
      const dataRegion = requireString(body, "dataRegion", 120);
      const retentionPolicy = requireString(body, "retentionPolicy", 500);
      const trainingPolicy = requireString(body, "trainingPolicy", 500);
      const maxBudgetUsd = body.maxBudgetUsd ?? 25;
      const maxTurns = body.maxTurns ?? 100;
      const timeoutSeconds = body.timeoutSeconds ?? 7200;
      if (typeof maxBudgetUsd !== "number" || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 100
        || !Number.isInteger(maxTurns) || (maxTurns as number) < 1 || (maxTurns as number) > 200
        || !Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 60 || (timeoutSeconds as number) > 14_400) {
        throw new HttpProblem(400, "BUDGET_OUT_OF_POLICY", "Profile budget or timeout exceeds platform limits");
      }
      const scope = body.scope === undefined ? "platform" : body.scope;
      if (scope !== "platform" && scope !== "tenant" && scope !== "project") {
        throw new HttpProblem(400, "PROFILE_SCOPE_REJECTED", "Profile scope must be platform, tenant or project");
      }
      const scopeId = body.scopeId === undefined ? scope === "platform" ? "global" : "" : requireString(body, "scopeId", 160);
      if ((scope === "platform" && scopeId !== "global")
        || (scope !== "platform" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(scopeId))) {
        throw new HttpProblem(400, "PROFILE_SCOPE_REJECTED", "Profile scope identifier is invalid");
      }
      const actor = localActor(request, role);
      assertLocalProfileActor(actor, scope, scopeId);
      const installationId = requireString(body, "installationId", 160);
      const currentStore = getDemoStore();
      const installation = currentStore.installations.find((item) => item.id === installationId);
      if (!installation || installation.agent !== agent || !["READY", "CANARY", "ACTIVE"].includes(installation.state)
        || !installation.imageDigest || !["APPROVED", "DEPRECATED"].includes(currentStore.agentVersions[`${agent}@${installation.version}`])) {
        throw new HttpProblem(409, "INSTALLATION_NOT_SELECTABLE", "Profile requires a supply-chain-attested Installation for the selected Agent");
      }
      const credential = currentStore.credentials.find((item) => item.id === credentialVersionId && item.state === "ACTIVE");
      const fixtureCredential = scope === "platform" && currentStore.providers.some((item) => item.agent === agent
        && item.credentialVersionId === credentialVersionId && item.state === "ACTIVE");
      if (!credential && !fixtureCredential) {
        throw new HttpProblem(409, "CREDENTIAL_NOT_SELECTABLE", "Profile requires an active credential version for the selected Agent");
      }
      if (credential) assertLocalProfileCredential(actor, scope, scopeId, credential);
      const fallbackProfileRevisionId = typeof body.fallbackProfileRevisionId === "string" ? body.fallbackProfileRevisionId : null;
      if (fallbackProfileRevisionId) {
        const fallback = currentStore.profiles.find((item) => item.id === fallbackProfileRevisionId);
        if (!fallback || fallback.agent !== agent || fallback.state !== "ACTIVE"
          || fallback.scope !== scope || fallback.scopeId !== scopeId) {
          throw new HttpProblem(409, "FALLBACK_NOT_SELECTABLE", "Fallback must be an active immutable Profile for the same Agent and scope");
        }
      }
      return await mutate(lease, `admin:${key}:${scope}:${scopeId}:${idempotency}`, () => {
        const store = getDemoStore();
        store.resourceSequences.provider += 1;
        store.resourceSequences.profile += 1;
        const providerId = `provider-${agent}-${store.resourceSequences.provider}`;
        const profile: DemoProfile = {
          id: `profile-${agent}-${store.resourceSequences.profile}-r1`,
          revision: 1,
          scope,
          scopeId,
          agent,
          providerRevisionId: providerId,
          installationId,
          credentialVersionId,
          state: "DRAFT",
          budget: { maxUsd: maxBudgetUsd, maxTurns: maxTurns as number, timeoutSeconds: timeoutSeconds as number },
          fallbackProfileRevisionId,
          createdAt: new Date().toISOString(),
        };
        store.providers.push({
          id: providerId,
          revision: 1,
          agent,
          protocol,
          baseUrl,
          approvedPorts: [443],
          authentication,
          models,
          pricing: { inputUsdPerMillionTokens, outputUsdPerMillionTokens },
          credentialVersionId,
          governance: {
            dataRegion,
            retentionPolicy,
            trainingPolicy,
            confirmedBy: actor.actorId,
            confirmedAt: new Date().toISOString(),
          },
          state: "DRAFT",
          probe: {},
        });
        store.profiles.push(profile);
        appendDemoAudit("AGENT_PROFILE_DRAFTED", profile.id, role, {
          agent, protocol, baseUrl, dataRegion,
          governanceConfirmed: Boolean(retentionPolicy && trainingPolicy),
          maxTurns: maxTurns as number,
          timeoutSeconds: timeoutSeconds as number,
        });
        return { profile, provider: store.providers.at(-1) };
      });
    }

    const rebindProfileMatch = /^agent-profiles\/([^/]+)\/rebind-installation$/.exec(key);
    if (rebindProfileMatch) {
      const role = requireRole(request, PROFILE_ROLES);
      const actor = localActor(request, role);
      assertAllowedBodyFields(body, ["installationId"]);
      const sourceProfileId = rebindProfileMatch[1] ?? "";
      const installationId = requireString(body, "installationId", 180);
      const snapshot = getDemoStore();
      const source = snapshot.profiles.find((item) => item.id === sourceProfileId);
      if (!source) throw new HttpProblem(404, "PROFILE_NOT_FOUND", "Profile revision does not exist");
      assertLocalProfileActor(actor, source.scope, source.scopeId);
      if (source.state !== "ACTIVE") {
        throw new HttpProblem(409, "SOURCE_PROFILE_NOT_ACTIVE", "Only an active immutable Profile can be rebound to an upgraded Installation");
      }
      if (source.installationId === installationId) {
        throw new HttpProblem(409, "INSTALLATION_ALREADY_BOUND", "Profile already uses the requested Installation");
      }
      const provider = snapshot.providers.find((item) => item.id === source.providerRevisionId);
      if (!provider || provider.agent !== source.agent || provider.state !== "ACTIVE"
        || provider.credentialVersionId !== source.credentialVersionId || !demoProviderProbePassed(provider)) {
        throw new HttpProblem(409, "PROVIDER_NOT_REUSABLE", "Installation rebind requires the source Profile's active, fully probed Provider");
      }
      const credential = snapshot.credentials.find((item) => item.id === source.credentialVersionId && item.state === "ACTIVE");
      const fixtureCredential = source.scope === "platform" && provider.state === "ACTIVE";
      if (!credential && !fixtureCredential) {
        throw new HttpProblem(409, "CREDENTIAL_NOT_ACTIVE", "Installation rebind requires the source Profile's active credential version");
      }
      if (credential) assertLocalProfileCredential(actor, source.scope, source.scopeId, credential);
      if (source.fallbackProfileRevisionId) {
        const fallback = snapshot.profiles.find((item) => item.id === source.fallbackProfileRevisionId);
        if (!fallback || fallback.state !== "ACTIVE" || fallback.agent !== source.agent
          || fallback.scope !== source.scope || fallback.scopeId !== source.scopeId) {
          throw new HttpProblem(409, "FALLBACK_NOT_SELECTABLE", "The source Profile fallback is no longer active in the same Agent scope");
        }
      }
      const installation = snapshot.installations.find((item) => item.id === installationId);
      const versionKey = installation ? `${installation.agent}@${installation.version}` : "";
      const versionState = snapshot.agentVersions[versionKey];
      const versionMetadata = snapshot.agentVersionMetadata[versionKey];
      if (!installation || installation.agent !== source.agent || installation.state !== "ACTIVE"
        || installation.health !== "HEALTHY" || installation.rolloutPercent !== 100 || !installation.activatedAt
        || !installation.imageDigest || !installation.buildReceiptId || !installation.buildReceiptDigest
        || !versionState || !["APPROVED", "DEPRECATED"].includes(versionState)
        || !versionMetadata?.signatureVerified || versionMetadata.scan !== "PASS"
        || !versionMetadata.validationReceiptId || !versionMetadata.validationReceiptDigest
        || !versionMetadata.supplyChainEvidenceDigest || !versionMetadata.validatedAdapterVersion
        || !versionMetadata.adapterCompatibility
        || !isAdapterVersionAttested(installation.adapterVersion, versionMetadata.validatedAdapterVersion, versionMetadata.adapterCompatibility)) {
        throw new HttpProblem(409, "INSTALLATION_NOT_SERVING_READY", "Installation rebind requires a healthy 100% active WorkerImage with complete supply-chain attestation");
      }
      const digest = await fingerprintSecret(new TextEncoder().encode(
        `profile-installation-rebind\0${source.id}\0${source.installationId}\0${installationId}`,
      ));
      const successorId = `profile-installation-rebind-${digest.slice(7, 31)}-r${source.revision + 1}`;
      return await mutate(lease, `admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        const currentSource = store.profiles.find((item) => item.id === sourceProfileId);
        const currentProvider = currentSource
          ? store.providers.find((item) => item.id === currentSource.providerRevisionId)
          : undefined;
        if (!currentSource || currentSource.state !== "ACTIVE" || !currentProvider || currentProvider.state !== "ACTIVE"
          || !demoProviderProbePassed(currentProvider)) {
          throw new HttpProblem(409, "PROFILE_REBIND_RACE", "Source Profile or Provider changed before the rebind could commit");
        }
        const existing = store.profiles.find((item) => item.id === successorId);
        if (existing) {
          if (existing.revision !== currentSource.revision + 1 || existing.installationId !== installationId
            || existing.providerRevisionId !== currentSource.providerRevisionId
            || existing.credentialVersionId !== currentSource.credentialVersionId
            || existing.fallbackProfileRevisionId !== currentSource.fallbackProfileRevisionId
            || existing.scope !== currentSource.scope || existing.scopeId !== currentSource.scopeId
            || existing.agent !== currentSource.agent) {
            throw new HttpProblem(409, "PROFILE_REBIND_CONFLICT", "An immutable Profile rebind successor conflicts with this request");
          }
          return {
            profile: existing,
            provider: { id: currentProvider.id, state: currentProvider.state, probe: currentProvider.probe },
            sourceProfileRevisionId: currentSource.id,
            providerReused: true,
            requiresSecurityActivation: existing.state === "READY",
            defaultsChanged: false,
            affectsQueuedOrRunningTasks: false,
          };
        }
        const profile: DemoProfile = {
          ...currentSource,
          id: successorId,
          revision: currentSource.revision + 1,
          installationId,
          state: "READY",
          createdAt: new Date().toISOString(),
        };
        store.profiles.push(profile);
        appendDemoAudit("AGENT_PROFILE_INSTALLATION_REBOUND", profile.id, actor.actorId, {
          sourceProfileRevisionId: currentSource.id,
          previousInstallationId: currentSource.installationId,
          installationId,
          providerRevisionId: currentProvider.id,
          profileState: profile.state,
          providerReused: true,
          requiresSecurityActivation: true,
          defaultsChanged: false,
          affectsQueuedOrRunningTasks: false,
        });
        return {
          profile,
          provider: { id: currentProvider.id, state: currentProvider.state, probe: currentProvider.probe },
          sourceProfileRevisionId: currentSource.id,
          providerReused: true,
          requiresSecurityActivation: true,
          defaultsChanged: false,
          affectsQueuedOrRunningTasks: false,
        };
      });
    }

    const profileMatch = /^agent-profiles\/([^/]+)\/(validate|activate|disable)$/.exec(key);
    if (profileMatch) {
      const role = requireRole(request, profileMatch[2] === "activate" ? SECURITY_ROLES : PROFILE_ROLES);
      const actor = localActor(request, role);
      assertAllowedBodyFields(body, []);
      const profileId = profileMatch[1] ?? "";
      const action = profileMatch[2];
      const authorizedProfile = getDemoStore().profiles.find((item) => item.id === profileId);
      if (!authorizedProfile) throw new HttpProblem(404, "PROFILE_NOT_FOUND", "Profile revision does not exist");
      assertLocalProfileActor(actor, authorizedProfile.scope, authorizedProfile.scopeId);
      if (action === "validate") {
        const operationId = `admin:${key}:${idempotency}`;
        if (Object.prototype.hasOwnProperty.call(getDemoStore().idempotency, operationId)) {
          return await mutate(lease, operationId, () => { throw new Error("idempotency replay must not execute"); });
        }
        if (!localProviderControlRequired()) {
          throw new HttpProblem(
            503,
            "PROVIDER_PROBE_NOT_CONFIGURED",
            "本地测试站尚未配置受信 Provider Connector；草稿已保留，不能伪造探针通过或覆盖当前生效配置",
          );
        }
        const store = getDemoStore();
        const profile = store.profiles.find((item) => item.id === profileId);
        const provider = profile && store.providers.find((item) => item.id === profile.providerRevisionId);
        if (!profile || !provider) throw new HttpProblem(409, "PROVIDER_NOT_FOUND", "Profile Provider revision is missing");
        if (!["DRAFT", "DEGRADED"].includes(profile.state) || !["DRAFT", "READY"].includes(provider.state)) {
          throw new HttpProblem(409, "PROFILE_NOT_VALIDATABLE", "Only a draft or degraded Profile can run a new Provider probe");
        }
        const checks = await probeLocalProvider({
          providerRevisionId: provider.id,
          agent: provider.agent,
          protocol: provider.protocol,
          baseUrl: provider.baseUrl,
          approvedPorts: provider.approvedPorts,
          authentication: provider.authentication,
          models: provider.models,
          credentialVersionId: provider.credentialVersionId,
          requiredChecks: PROVIDER_REQUIRED_CHECKS,
        }, {
          profileRevisionId: profile.id,
          scope: profile.scope,
          scopeId: profile.scopeId,
          pricing: provider.pricing,
        });
        return await mutate(lease, operationId, () => {
          const currentStore = getDemoStore();
          const currentProfile = currentStore.profiles.find((item) => item.id === profileId);
          const currentProvider = currentProfile && currentStore.providers.find((item) => item.id === currentProfile.providerRevisionId);
          if (!currentProfile || !currentProvider) throw new HttpProblem(409, "PROVIDER_NOT_FOUND", "Profile Provider revision is missing");
          const previousState = currentProfile.state;
          const previousProviderState = currentProvider.state;
          currentProvider.probe = { ...checks };
          currentProvider.state = "READY";
          currentProfile.state = "READY";
          appendDemoAudit("AGENT_PROFILE_VALIDATE", currentProfile.id, actor.actorId, {
            providerRevisionId: currentProvider.id,
            previousState,
            state: currentProfile.state,
            previousProviderState,
            providerState: currentProvider.state,
            requiredChecks: PROVIDER_REQUIRED_CHECKS.length,
          });
          return {
            profile: currentProfile,
            provider: { id: currentProvider.id, state: currentProvider.state, probe: currentProvider.probe },
            previousActivePreserved: true,
          };
        });
      }
      const operationId = `admin:${key}:${idempotency}`;
      if (Object.prototype.hasOwnProperty.call(getDemoStore().idempotency, operationId)) {
        return await mutate(lease, operationId, () => { throw new Error("idempotency replay must not execute"); });
      }
      const currentProvider = getDemoStore().providers.find((item) => item.id === authorizedProfile.providerRevisionId);
      if (!currentProvider) throw new HttpProblem(409, "PROVIDER_NOT_FOUND", "Profile Provider revision is missing");
      if (action === "activate") {
        if (authorizedProfile.state !== "READY" || !["READY", "ACTIVE"].includes(currentProvider.state)
          || !demoProviderProbePassed(currentProvider)) {
          throw new HttpProblem(409, "PROBE_REQUIRED", "Validate the draft and pass every probe before activation");
        }
        if (localProviderControlRequired()) {
          await activateLocalProviderBinding({
            providerRevisionId: currentProvider.id,
            profileRevisionId: authorizedProfile.id,
            credentialVersionId: currentProvider.credentialVersionId,
          });
        }
      } else if (localProviderControlRequired()) {
        await disableLocalProviderBinding({
          providerRevisionId: currentProvider.id,
          profileRevisionId: authorizedProfile.id,
        });
      }
      return await mutate(lease, operationId, () => {
        const store = getDemoStore();
        const profile = store.profiles.find((item) => item.id === profileId);
        if (!profile) throw new HttpProblem(404, "PROFILE_NOT_FOUND", "Profile revision does not exist");
        assertLocalProfileActor(actor, profile.scope, profile.scopeId);
        const provider = store.providers.find((item) => item.id === profile.providerRevisionId);
        if (!provider) throw new HttpProblem(409, "PROVIDER_NOT_FOUND", "Profile Provider revision is missing");
        const previousState = profile.state;
        const previousProviderState = provider.state;
        if (action === "activate") {
          if (profile.state !== "READY" || !["READY", "ACTIVE"].includes(provider.state) || !demoProviderProbePassed(provider)) {
            throw new HttpProblem(409, "PROBE_REQUIRED", "Validate the draft and pass every probe before activation");
          }
          profile.state = "ACTIVE";
          if (provider.state === "READY") provider.state = "ACTIVE";
        } else {
          profile.state = "DISABLED";
          const providerStillReferenced = store.profiles.some((candidate) => candidate.id !== profile.id
            && candidate.providerRevisionId === provider.id && !["SUPERSEDED", "DISABLED"].includes(candidate.state));
          if (!providerStillReferenced) provider.state = "DISABLED";
        }
        appendDemoAudit(`AGENT_PROFILE_${action?.toUpperCase()}`, profile.id, actor.actorId, {
          providerRevisionId: provider.id,
          previousState,
          state: profile.state,
          previousProviderState,
          providerState: provider.state,
        });
        return { profile, provider: { id: provider.id, state: provider.state, probe: provider.probe }, previousActivePreserved: action === "validate" };
      });
    }

    if (key === "credentials") {
      const role = requireRole(request, ["SecurityAdmin", "TenantAdmin"]);
      const actor = localActor(request, role);
      const credentialScope = role === "SecurityAdmin"
        ? { scope: "platform" as const, scopeId: "global" }
        : { scope: "tenant" as const, scopeId: actor.tenantId! };
      assertAllowedBodyFields(body, ["label", "apiKey"]);
      const label = requireString(body, "label", 120);
      const secret = requireString(body, "apiKey", 8192);
      if (secret.length < 8) throw new HttpProblem(400, "CREDENTIAL_TOO_SHORT", "Credential must be at least 8 characters");
      const operationId = `admin:${key}:${credentialScope.scope}:${credentialScope.scopeId}:${idempotency}`;
      if (Object.prototype.hasOwnProperty.call(getDemoStore().idempotency, operationId)) {
        body.apiKey = "[DESTROYED_ON_IDEMPOTENT_REPLAY]";
        return await mutate(lease, operationId, () => { throw new Error("idempotency replay must not execute"); });
      }
      const credentialSequence = getDemoStore().resourceSequences.credential + 1;
      const familyId = `credential-${credentialSequence}`;
      const id = `${familyId}-v1`;
      const bytes = new TextEncoder().encode(secret);
      let fingerprint: `sha256:${string}`;
      let secretRef = `vault://kv/data/deviludo/${id}#1`;
      try {
        fingerprint = await fingerprintSecret(bytes);
        if (localProviderControlRequired()) {
          const receipt = await putLocalProviderCredential(id, secret, fingerprint);
          secretRef = receipt.secretRef;
        }
      } finally {
        bytes.fill(0);
        body.apiKey = "[DESTROYED_AFTER_VAULT_INGRESS]";
      }
      return await mutate(lease, operationId, () => {
        const store = getDemoStore();
        store.resourceSequences.credential = Math.max(store.resourceSequences.credential, credentialSequence);
        const credential = {
          id,
          familyId,
          label,
          ...credentialScope,
          secretRef,
          fingerprint,
          masked: maskFingerprint(fingerprint),
          version: 1,
          state: "ACTIVE" as const,
          createdAt: new Date().toISOString(),
          rotatedAt: null,
        };
        store.credentials.push(credential);
        appendDemoAudit("CREDENTIAL_CREATED", id, actor.actorId, {
          label, credentialVersion: credential.version, scope: credential.scope, scopeId: credential.scopeId,
        });
        return { id: credential.id, label: credential.label, maskedFingerprint: credential.masked,
          familyId: credential.familyId, scope: credential.scope, scopeId: credential.scopeId,
          version: credential.version, state: credential.state, createdAt: credential.createdAt,
          rotatedAt: credential.rotatedAt, plaintextRecoverable: false };
      });
    }

    const credentialMatch = /^credentials\/([^/]+)\/(rotate|revoke)$/.exec(key);
    if (credentialMatch) {
      const role = requireRole(request, ["SecurityAdmin", "TenantAdmin"]);
      const actor = localActor(request, role);
      const credentialId = credentialMatch[1] ?? "";
      const action = credentialMatch[2];
      assertAllowedBodyFields(body, action === "rotate" ? ["apiKey"] : []);
      const authorizedCredential = getDemoStore().credentials.find((item) => item.id === credentialId);
      if (!authorizedCredential) throw new HttpProblem(404, "CREDENTIAL_NOT_FOUND", "Credential version does not exist");
      assertLocalCredentialActor(actor, authorizedCredential);
      const operationId = `admin:${key}:${idempotency}`;
      if (Object.prototype.hasOwnProperty.call(getDemoStore().idempotency, operationId)) {
        if (action === "rotate") body.apiKey = "[DESTROYED_ON_IDEMPOTENT_REPLAY]";
        return await mutate(lease, operationId, () => { throw new Error("idempotency replay must not execute"); });
      }
      let replacementFingerprint: `sha256:${string}` | null = null;
      let replacementSecretRef: string | null = null;
      if (action === "rotate") {
        const replacement = requireString(body, "apiKey", 8192);
        if (replacement.length < 8) throw new HttpProblem(400, "CREDENTIAL_TOO_SHORT", "Replacement credential must be at least 8 characters");
        const localStore = getDemoStore();
        const activeProviderIds = new Set(localStore.providers
          .filter((provider) => provider.credentialVersionId === credentialId && provider.state === "ACTIVE")
          .map((provider) => provider.id));
        if (localStore.profiles.some((profile) => profile.state === "ACTIVE" && activeProviderIds.has(profile.providerRevisionId))) {
          throw new HttpProblem(
            503,
            "PROVIDER_PROBE_NOT_CONFIGURED",
            "本地测试站不会为生效 Provider 伪造新 Key 探针；当前凭据和默认 Profile 保持不变",
          );
        }
        if (authorizedCredential.state !== "ACTIVE") throw new HttpProblem(409, "CREDENTIAL_NOT_ACTIVE", "Only the active credential version can be rotated");
        const nextVersion = authorizedCredential.version + 1;
        const replacementId = authorizedCredential.id.replace(/-v\d+$/, `-v${nextVersion}`);
        const bytes = new TextEncoder().encode(replacement);
        try {
          replacementFingerprint = await fingerprintSecret(bytes);
          if (replacementFingerprint === authorizedCredential.fingerprint) {
            throw new HttpProblem(409, "CREDENTIAL_REUSED", "Replacement credential must differ from the active version");
          }
          if (localProviderControlRequired()) {
            const receipt = await putLocalProviderCredential(replacementId, replacement, replacementFingerprint);
            replacementSecretRef = receipt.secretRef;
          } else {
            replacementSecretRef = authorizedCredential.secretRef.replace(/#\d+$/, `#${nextVersion}`);
          }
        } finally {
          bytes.fill(0);
          body.apiKey = "[DESTROYED_AFTER_VAULT_INGRESS]";
        }
      } else if (localProviderControlRequired()) {
        await revokeLocalProviderCredential(credentialId);
      }
      return await mutate(lease, operationId, () => {
        const store = getDemoStore();
        const credential = store.credentials.find((item) => item.id === credentialId);
        if (!credential) throw new HttpProblem(404, "CREDENTIAL_NOT_FOUND", "Credential version does not exist");
        assertLocalCredentialActor(actor, credential);
        if (action === "revoke") {
          const previousState = credential.state;
          credential.state = "REVOKED";
          const affectedProviderIds = new Set(store.providers
            .filter((provider) => provider.credentialVersionId === credential.id)
            .map((provider) => {
              provider.state = "DISABLED";
              provider.probe = {};
              return provider.id;
            }));
          let degradedProfiles = 0;
          for (const profile of store.profiles) {
            if (affectedProviderIds.has(profile.providerRevisionId) && profile.state === "ACTIVE") {
              profile.state = "DEGRADED";
              degradedProfiles += 1;
            }
          }
          appendDemoAudit("CREDENTIAL_REVOKE", credential.id, actor.actorId, {
            previousState, state: credential.state, newTokensIssued: false, degradedProfiles,
          });
          return { id: credential.id, state: credential.state, newTokensIssued: false, degradedProfiles, plaintextRecoverable: false };
        }
        if (credential.state !== "ACTIVE") throw new HttpProblem(409, "CREDENTIAL_NOT_ACTIVE", "Only the active credential version can be rotated");
        if (!replacementFingerprint) throw new HttpProblem(400, "REPLACEMENT_REQUIRED", "Rotation requires new credential material");
        if (replacementFingerprint === credential.fingerprint) throw new HttpProblem(409, "CREDENTIAL_REUSED", "Replacement credential must differ from the active version");
        if (!replacementSecretRef) throw new HttpProblem(500, "CREDENTIAL_STORE_RECEIPT_MISSING", "Credential store receipt is missing");
        const rotatedAt = new Date().toISOString();
        credential.state = "PREVIOUS";
        credential.rotatedAt = rotatedAt;
        const nextVersion = credential.version + 1;
        const replacement = {
          ...credential,
          id: credential.id.replace(/-v\d+$/, `-v${nextVersion}`),
          secretRef: replacementSecretRef,
          fingerprint: replacementFingerprint,
          masked: maskFingerprint(replacementFingerprint),
          version: nextVersion,
          state: "ACTIVE" as const,
          createdAt: rotatedAt,
          rotatedAt,
        };
        store.credentials.push(replacement);
        appendDemoAudit("CREDENTIAL_ROTATE", credential.id, actor.actorId, {
          replacementVersionId: replacement.id, rotatedAt, newTasksOnly: true,
        });
        return {
          id: replacement.id, previousId: credential.id, state: replacement.state,
          fingerprint: replacement.masked, rotatedAt, newTokensIssued: true,
          oldVersionNoLongerIssued: true, plaintextRecoverable: false,
        };
      });
    }

    if (/^inference-requests\/[a-f0-9-]+\/reconcile$/i.test(key)) {
      requireRole(request, SECURITY_ROLES);
      throw new HttpProblem(
        503,
        "INFERENCE_RECONCILIATION_GATEWAY_REQUIRED",
        "本地测试站不会伪造上游账单核销；请配置生产控制面与受信 mTLS Inference Gateway",
      );
    }

    if (/^spec-model-generations\/[a-f0-9]{64}\/reconcile$/i.test(key)) {
      requireRole(request, SECURITY_ROLES);
      throw new HttpProblem(
        503,
        "SPEC_MODEL_RECONCILIATION_BROKER_REQUIRED",
        "本地测试站不会伪造规格模型账单核销；请配置生产控制面与受信 mTLS 规格模型 Broker",
      );
    }

    throw new HttpProblem(404, "NOT_FOUND", `Unknown admin action: ${key}`);
  } catch (error) {
    return problemResponse(error);
  } finally {
    lease?.release();
  }
}

export async function PUT(request: Request, context: RouteContext) {
  let lease: LocalAdminStateLease | null = null;
  try {
    const { segments } = await context.params;
    if (!isLoopbackTestRequest(request)) return productionAdminRequest(request, segments);
    requireLocalAdmin(request);
    lease = await acquireLocalAdminState();
    const key = routeKey(segments);
    const match = /^agent-defaults\/(platform|tenant:[a-z0-9-]+|project:[a-z0-9-]+)$/i.exec(key);
    if (!match) throw new HttpProblem(404, "NOT_FOUND", `Unknown admin resource: ${key}`);
    const role = requireRole(request, match[1]?.startsWith("platform") ? VERSION_ROLES : PROFILE_ROLES);
    const actor = localActor(request, role);
    const body = await bodyObject(request);
    assertAllowedBodyFields(body, ["profileRevisionId"]);
    const profileRevisionId = requireString(body, "profileRevisionId", 160);
    const commandKey = `admin:${key}:${idempotencyKey(request)}`;
    const result = withIdempotency(commandKey, () => {
      const store = getDemoStore();
      const profile = store.profiles.find((item) => item.id === profileRevisionId && item.state === "ACTIVE");
      if (!profile) {
        throw new HttpProblem(409, "PROFILE_NOT_ACTIVE", "Defaults can only reference an active immutable Profile revision");
      }
      const scope = match[1] ?? "platform";
      const [scopeKind, scopeId = "global"] = scope.split(":");
      assertLocalDefaultActor(actor, scopeKind as DemoProfile["scope"], scopeId);
      const selectable = scopeKind === "platform"
        ? profile.scope === "platform" && profile.scopeId === "global"
        : profile.scope === "platform" && profile.scopeId === "global"
          || profile.scope === scopeKind && profile.scopeId === scopeId
          || scopeKind === "project" && profile.scope === "tenant" && profile.scopeId === actor.tenantId;
      if (!selectable) {
        throw new HttpProblem(409, "PROFILE_SCOPE_MISMATCH", "Profile revision is outside the active configuration inherited by this scope");
      }
      const installation = store.installations.find((item) => item.id === profile.installationId);
      const provider = store.providers.find((item) => item.id === profile.providerRevisionId);
      if (!installation || installation.agent !== profile.agent || installation.state !== "ACTIVE"
        || installation.health !== "HEALTHY" || installation.rolloutPercent !== 100 || !installation.activatedAt
        || !["APPROVED", "DEPRECATED"].includes(store.agentVersions[`${installation.agent}@${installation.version}`])
        || !provider || provider.agent !== profile.agent || provider.state !== "ACTIVE"
        || profile.credentialVersionId !== provider.credentialVersionId || !providerConfigurationComplete(provider)) {
        throw new HttpProblem(
          409,
          "PROFILE_NOT_SERVING_READY",
          "Defaults require a fully active Installation, supply-chain-attested version and active Provider",
        );
      }
      const defaultScope = match[1] ?? "platform";
      const previousProfileRevisionId = store.defaults[defaultScope] ?? "none";
      store.defaults[defaultScope] = profileRevisionId;
      appendDemoAudit("AGENT_DEFAULT_UPDATED", defaultScope, actor.actorId, {
        previousProfileRevisionId, profileRevisionId, affectsRunningTasks: false,
      });
      return { scope: match[1], profileRevisionId, precedence: "project > tenant > platform > claude-code", affectsNewTasksOnly: true };
    });
    if (!result.replayed) await lease.persist(commandKey);
    return json({ data: result.value, meta: { idempotentReplay: result.replayed } });
  } catch (error) {
    return problemResponse(error);
  } finally {
    lease?.release();
  }
}

function providerConfigurationComplete(provider: DemoProvider): boolean {
  try {
    const roles = normalizeModelRoles(provider.models);
    return roles.primaryModel === provider.models.primaryModel
      && provider.approvedPorts.length > 0
      && provider.approvedPorts.every((port) => Number.isInteger(port) && port === 443)
      && Boolean(provider.governance.dataRegion && provider.governance.retentionPolicy && provider.governance.trainingPolicy)
      && Boolean(provider.governance.confirmedBy && provider.governance.confirmedAt)
      && Number.isFinite(Date.parse(provider.governance.confirmedAt ?? ""));
  } catch {
    return false;
  }
}

function rollbackDemoProfiles(store: DemoStoreState, installation: DemoInstallation): readonly string[] {
  const target = installation.rollbackInstallationId
    ? store.installations.find((item) => item.id === installation.rollbackInstallationId
      && item.health === "HEALTHY" && item.state === "ACTIVE" && item.rolloutPercent === 100)
    : undefined;
  const direct = store.profiles.filter((profile) =>
    profile.installationId === installation.id && profile.state === "ACTIVE");
  const affected = new Set(direct.map((profile) => profile.id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const profile of store.profiles) {
      if (profile.state === "ACTIVE" && !affected.has(profile.id) && profile.fallbackProfileRevisionId
        && affected.has(profile.fallbackProfileRevisionId)) {
        affected.add(profile.id);
        expanded = true;
      }
    }
  }
  if (!target) {
    for (const profile of store.profiles) {
      if ((profile.installationId === installation.id || affected.has(profile.id))
        && !["SUPERSEDED", "DISABLED"].includes(profile.state)) profile.state = "DEGRADED";
    }
    return Object.freeze([]);
  }

  const sources = store.profiles.filter((profile) => affected.has(profile.id));
  const successorIds = new Map(sources.map((profile) => [
    profile.id,
    `profile-local-rollback-${profile.id.replace(/[^a-z0-9]/gi, "-").slice(-48)}-r${profile.revision + 1}`,
  ]));
  const replacements: DemoProfile[] = sources.map((profile) => ({
    ...profile,
    id: successorIds.get(profile.id)!,
    revision: profile.revision + 1,
    installationId: profile.installationId === installation.id ? target.id : profile.installationId,
    fallbackProfileRevisionId: profile.fallbackProfileRevisionId
      ? successorIds.get(profile.fallbackProfileRevisionId) ?? profile.fallbackProfileRevisionId
      : null,
    createdAt: new Date().toISOString(),
    state: "ACTIVE",
  }));
  for (const replacement of replacements) {
    const existing = store.profiles.find((profile) => profile.id === replacement.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(replacement)) {
      throw new HttpProblem(409, "PROFILE_ROLLBACK_RACE", "Local Profile rollback successor conflicts with an existing revision");
    }
    if (!existing) store.profiles.push(replacement);
  }
  for (const source of sources) {
    source.state = "SUPERSEDED";
    const successorId = successorIds.get(source.id)!;
    for (const [scope, profileId] of Object.entries(store.defaults)) {
      if (profileId === source.id) store.defaults[scope] = successorId;
    }
  }
  return Object.freeze(replacements.map((profile) => profile.id));
}

function demoProfileReferencesInstallation(
  store: DemoStoreState,
  profileId: string,
  installationId: string,
): boolean {
  const visited = new Set<string>();
  let current: string | null = profileId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const profile = store.profiles.find((item) => item.id === current);
    if (!profile) return false;
    if (profile.installationId === installationId) return true;
    current = profile.fallbackProfileRevisionId;
  }
  return false;
}

function selectDemoRollbackInstallation(
  store: DemoStoreState,
  agent: DemoInstallation["agent"],
  workerPool: string,
): DemoInstallation | null {
  const candidates = store.installations.filter((item) => item.agent === agent && item.workerPool === workerPool
    && item.state === "ACTIVE" && item.health === "HEALTHY" && item.rolloutPercent === 100 && !!item.activatedAt
    && Number.isFinite(Date.parse(item.activatedAt)));
  candidates.sort((left, right) => {
    const activationOrder = Date.parse(right.activatedAt!) - Date.parse(left.activatedAt!);
    if (activationOrder !== 0) return activationOrder;
    const creationOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return creationOrder || right.id.localeCompare(left.id);
  });
  return candidates[0] ?? null;
}

function demoProviderProbePassed(provider: DemoProvider): boolean {
  const keys = Object.keys(provider.probe);
  return keys.length === PROVIDER_REQUIRED_CHECKS.length
    && PROVIDER_REQUIRED_CHECKS.every((check) => provider.probe[check] === "PASS");
}

async function mutate<T>(lease: LocalAdminStateLease, idempotency: string, operation: () => T): Promise<Response> {
  const result = withIdempotency(idempotency, operation);
  if (!result.replayed) await lease.persist(idempotency);
  return json({ data: result.value, meta: { idempotentReplay: result.replayed } }, { status: result.replayed ? 200 : 201 });
}

function optionalModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireLocalAdmin(request: Request): void {
  if (!isLoopbackTestRequest(request)) {
    throw new HttpProblem(503, "ADMIN_CONTROL_PLANE_REQUIRED", "生产管理员操作需要独立的身份认证与 Agent 控制面；本地演示存储已禁用");
  }
}

async function productionAdminRequest(request: Request, segments: readonly string[]): Promise<Response> {
  let downstreamPath: string;
  try {
    downstreamPath = resolveAdminControlPlanePath(request.method, segments);
    const url = new URL(request.url);
    if (url.search || url.pathname !== `/api${downstreamPath}`) throw new Error("route mismatch");
  } catch {
    return json({ error: { code: "ADMIN_ROUTE_NOT_ALLOWED", message: "该管理员控制面路由未开放。" } }, { status: 404 });
  }
  if (request.method !== "GET" && !browserMutationIsSameOrigin(request)) {
    return json({ error: { code: "CROSS_ORIGIN_MUTATION_REJECTED", message: "浏览器管理操作必须来自当前站点。" } }, { status: 403 });
  }
  let principal;
  try { principal = await verifyTrustedAdminPrincipal(request); }
  catch { return json({ error: { code: "ADMIN_SESSION_INVALID", message: "需要可信平台管理员会话。" } }, { status: 401 }); }
  let broker;
  try { broker = adminControlPlaneBrokerFromEnvironment(); }
  catch { return json({ error: { code: "ADMIN_CONTROL_PLANE_MISCONFIGURED", message: "管理员控制面连接配置无效。" } }, { status: 503 }); }
  if (!broker) {
    return json({ error: { code: "ADMIN_CONTROL_PLANE_REQUIRED", message: "生产管理员操作需要独立的 Agent 控制面连接器。" } }, { status: 503 });
  }
  try { return await broker.forward(request, downstreamPath, principal); }
  catch { return json({ error: { code: "ADMIN_CONTROL_PLANE_UNAVAILABLE", message: "管理员控制面未能完成请求。" } }, { status: 502 }); }
}

function browserMutationIsSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin && !request.headers.has("cookie")) return true;
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}
