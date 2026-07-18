import { normalizeModelRoles } from "@/lib/agent/providers";
import { appendDemoAudit, getDemoStore, withIdempotency, type DemoProfile, type DemoProvider } from "@/lib/control-plane/demo-store";
import {
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

type RouteContext = { params: Promise<{ segments: string[] }> };
const VERSION_ROLES = ["PlatformAgentAdmin"] as const;
const SECURITY_ROLES = ["SecurityAdmin"] as const;
const PROFILE_ROLES = ["PlatformAgentAdmin", "SecurityAdmin", "TenantAdmin", "ProjectOwner"] as const;

function defaultAgent() {
  const store = getDemoStore();
  const profile = store.profiles.find((item) => item.id === store.defaults.platform && item.state === "ACTIVE");
  return profile?.agent ?? "claude-code";
}

function agentCatalog() {
  const store = getDemoStore();
  const selected = defaultAgent();
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      vendor: "Anthropic",
      officialSource: "https://code.claude.com/docs/en/installation",
      capabilities: ["plan", "code", "repair", "review"],
      supportedWorkers: ["linux/amd64", "linux/arm64"],
      default: selected === "claude-code",
      approvedVersions: Object.entries(store.agentVersions).filter(([key, state]) => key.startsWith("claude-code@") && state === "APPROVED").map(([key]) => key.split("@")[1]),
    },
    {
      id: "codex-cli",
      name: "Codex CLI",
      vendor: "OpenAI",
      officialSource: "https://developers.openai.com/codex/cli",
      capabilities: ["plan", "code", "repair", "review"],
      supportedWorkers: ["linux/amd64", "linux/arm64"],
      default: selected === "codex-cli",
      approvedVersions: Object.entries(store.agentVersions).filter(([key, state]) => key.startsWith("codex-cli@") && state === "APPROVED").map(([key]) => key.split("@")[1]),
    },
  ];
}

function routeKey(segments: string[]): string {
  return segments.join("/");
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { segments } = await context.params;
    const key = routeKey(segments);
    const store = getDemoStore();
    if (key === "agents") {
      return json({
        data: agentCatalog(),
        meta: {
          defaultAgent: defaultAgent(),
          revisionPolicy: "pinned-only",
          versions: Object.entries(store.agentVersions).map(([id, state]) => {
            const separator = id.lastIndexOf("@");
            return { id, agent: id.slice(0, separator), version: id.slice(separator + 1), state };
          }),
          installations: store.installations,
          rollouts: store.rollouts,
          providers: store.providers,
          profiles: store.profiles,
          credentials: store.credentials.map(({ id, label, masked, version, state, createdAt }) => ({ id, label, masked, version, state, createdAt })),
          defaults: store.defaults,
        },
      });
    }
    if (key === "agent-health") {
      return json({
        data: {
          workers: [
            { pool: "dev-linux-a", agent: "claude-code", ready: 24, desired: 32, health: "HEALTHY" },
            { pool: "dev-linux-b", agent: "codex-cli", ready: 14, desired: 16, health: "HEALTHY" },
          ],
          providers: store.providers.map(({ id, state, probe }) => ({ id, state, probe })),
          e2eRunnersContainAgent: false,
          steamPublishersContainAgent: false,
          supplyChain: {
            mode: "LOCAL_DETERMINISTIC_BROKER",
            available: true,
            acceptsCallerAttestations: false,
          },
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
    throw new HttpProblem(404, "NOT_FOUND", `Unknown admin resource: ${key}`);
  } catch (error) {
    return problemResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { segments } = await context.params;
    const key = routeKey(segments);
    const body = await bodyObject(request);
    const idempotency = idempotencyKey(request);

    if (key === "agent-versions/discover") {
      const role = requireRole(request, VERSION_ROLES);
      return mutate(`admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        store.agentVersions["claude-code@2.1.15"] ??= "DISCOVERED";
        appendDemoAudit("AGENT_VERSION_DISCOVERED", "claude-code@2.1.15", role, { source: "official-manifest" });
        return { candidates: [{ agent: "claude-code", version: "2.1.15", state: "DISCOVERED", activated: false }] };
      });
    }

    if (key === "agent-versions/approve" || key === "agent-versions/block") {
      const role = requireRole(request, VERSION_ROLES);
      const id = requireString(body, "id", 120);
      const state = key.endsWith("approve") ? "APPROVED" as const : "BLOCKED" as const;
      const forbiddenAttestationFields = [
        "integrity", "signatureVerified", "scan", "sbomRef", "sourceDigest", "validationReceipt",
        "validationReceiptId", "validationReceiptDigest", "supplyChainEvidenceDigest", "validatedAt", "imageDigest",
      ];
      if (state === "APPROVED" && forbiddenAttestationFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
        throw new HttpProblem(400, "CALLER_ATTESTATION_FORBIDDEN", "签名、扫描、SBOM 与 digest 只能来自受信供应链 Broker，不能由管理员请求提供");
      }
      const receiptDigest = state === "APPROVED"
        ? await fingerprintSecret(new TextEncoder().encode(`local-agent-validation:v1:${id}`))
        : null;
      return mutate(`admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        if (!(id in store.agentVersions)) throw new HttpProblem(404, "VERSION_NOT_FOUND", "Agent version was not discovered");
        if (state === "APPROVED" && store.agentVersions[id] !== "DISCOVERED") {
          throw new HttpProblem(409, "INVALID_VERSION_TRANSITION", "Only a discovered version can be approved");
        }
        store.agentVersions[id] = state;
        appendDemoAudit(`AGENT_VERSION_${state}`, id, role, {
          automaticActivation: false,
          trustBoundary: "LOCAL_DETERMINISTIC_BROKER",
          ...(receiptDigest ? { validationReceiptDigest: receiptDigest } : {}),
        });
        return {
          id,
          state,
          immutable: true,
          activationRequired: state === "APPROVED",
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
      if ((agent !== "claude-code" && agent !== "codex-cli") || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(version)
        || !/^dev(?:elopment)?[-_a-z0-9]*$/i.test(workerPool) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(adapterVersion)) {
        throw new HttpProblem(400, "INVALID_INSTALLATION", "Agent and version must be exact supported identifiers");
      }
      const agentKind = agent as "claude-code" | "codex-cli";
      if (getDemoStore().agentVersions[`${agentKind}@${version}`] !== "APPROVED") {
        throw new HttpProblem(409, "VERSION_NOT_APPROVED", "Only a Broker-attested approved version can build a WorkerImage");
      }
      const versionSlug = version.replaceAll(".", "").replaceAll("-", "");
      const id = `${agentKind === "claude-code" ? "claude" : "codex"}-installation-${versionSlug}`;
      const imageDigest = await fingerprintSecret(new TextEncoder().encode(`local-worker-image:v1:${agentKind}:${version}:${adapterVersion}`));
      const buildReceiptDigest = await fingerprintSecret(new TextEncoder().encode(`local-build-receipt:v1:${id}:${imageDigest}:${workerPool}`));
      return mutate(`admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
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
          createdAt: new Date().toISOString(),
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
      const installationId = rolloutMatch[1] ?? "";
      const action = rolloutMatch[2];
      return mutate(`admin:${key}:${idempotency}`, () => {
        const rollout = getDemoStore().rollouts[installationId];
        if (!rollout) throw new HttpProblem(404, "INSTALLATION_NOT_FOUND", "Installation does not exist");
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
        }
        appendDemoAudit(`ROLLOUT_${action?.toUpperCase()}`, installationId, role, { percent: rollout.percent, affectsRunningTasks: false });
        return { installationId, ...rollout, affectsNewTasksOnly: true };
      });
    }

    if (key === "agent-profiles") {
      const role = requireRole(request, PROFILE_ROLES);
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
      return mutate(`admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        const providerId = `provider-${agent}-${store.providers.length + 1}`;
        const profile: DemoProfile = {
          id: `profile-${agent}-${store.profiles.length + 1}-r1`,
          revision: 1,
          scope: body.scope === "tenant" || body.scope === "project" ? body.scope : "platform",
          scopeId: typeof body.scopeId === "string" ? body.scopeId : "global",
          agent,
          providerId,
          installationId: requireString(body, "installationId", 160),
          state: "DRAFT",
          budgetUsd: typeof body.budgetUsd === "number" ? Math.min(100, Math.max(0, body.budgetUsd)) : 25,
          fallbackProfileId: typeof body.fallbackProfileId === "string" ? body.fallbackProfileId : null,
        };
        store.providers.push({
          id: providerId,
          revision: 1,
          agent,
          protocol,
          baseUrl,
          authentication,
          inputUsdPerMillionTokens,
          outputUsdPerMillionTokens,
          primaryModel: models.primaryModel,
          credentialId: requireString(body, "credentialId", 160),
          state: "DRAFT",
          probe: {},
        });
        store.profiles.push(profile);
        appendDemoAudit("AGENT_PROFILE_DRAFTED", profile.id, role, { agent, protocol, baseUrl });
        return { profile, provider: { id: providerId, protocol, baseUrl, authentication,
          pricing: { inputUsdPerMillionTokens, outputUsdPerMillionTokens }, models, state: "DRAFT" } };
      });
    }

    const profileMatch = /^agent-profiles\/([^/]+)\/(validate|activate|disable)$/.exec(key);
    if (profileMatch) {
      const role = requireRole(request, profileMatch[2] === "activate" ? SECURITY_ROLES : PROFILE_ROLES);
      const profileId = profileMatch[1] ?? "";
      const action = profileMatch[2];
      if (action === "validate") {
        throw new HttpProblem(
          503,
          "PROVIDER_PROBE_NOT_CONFIGURED",
          "本地测试站尚未配置受信 Provider Connector；草稿已保留，不能伪造探针通过或覆盖当前生效配置",
        );
      }
      return mutate(`admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        const profile = store.profiles.find((item) => item.id === profileId);
        if (!profile) throw new HttpProblem(404, "PROFILE_NOT_FOUND", "Profile revision does not exist");
        const provider = store.providers.find((item) => item.id === profile.providerId);
        if (!provider) throw new HttpProblem(409, "PROVIDER_NOT_FOUND", "Profile Provider revision is missing");
        if (action === "activate") {
          if (profile.state !== "READY" || provider.state !== "READY") throw new HttpProblem(409, "PROBE_REQUIRED", "Validate the draft and pass every probe before activation");
          profile.state = "ACTIVE";
          provider.state = "ACTIVE";
        } else {
          profile.state = "DISABLED";
          provider.state = "DISABLED";
        }
        appendDemoAudit(`AGENT_PROFILE_${action?.toUpperCase()}`, profile.id, role, { providerRevisionId: provider.id, state: profile.state });
        return { profile, provider: { id: provider.id, state: provider.state, probe: provider.probe }, previousActivePreserved: action === "validate" };
      });
    }

    if (key === "credentials") {
      const role = requireRole(request, ["SecurityAdmin", "TenantAdmin"]);
      const label = requireString(body, "label", 120);
      const secret = requireString(body, "apiKey", 8192);
      if (secret.length < 8) throw new HttpProblem(400, "CREDENTIAL_TOO_SHORT", "Credential must be at least 8 characters");
      const bytes = new TextEncoder().encode(secret);
      let fingerprint: `sha256:${string}`;
      try {
        fingerprint = await fingerprintSecret(bytes);
      } finally {
        bytes.fill(0);
        body.apiKey = "[DESTROYED_AFTER_VAULT_INGRESS]";
      }
      return mutate(`admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        const id = `credential-${store.credentials.length + 1}-v1`;
        const credential = {
          id,
          label,
          secretRef: `vault://kv/data/deviludo/${id}#1`,
          fingerprint,
          masked: maskFingerprint(fingerprint),
          version: 1,
          state: "ACTIVE" as const,
          createdAt: new Date().toISOString(),
        };
        store.credentials.push(credential);
        appendDemoAudit("CREDENTIAL_CREATED", id, role, { label, secretRef: credential.secretRef });
        return { ...credential, fingerprint: credential.masked, plaintextRecoverable: false };
      });
    }

    const credentialMatch = /^credentials\/([^/]+)\/(rotate|revoke)$/.exec(key);
    if (credentialMatch) {
      const role = requireRole(request, ["SecurityAdmin", "TenantAdmin"]);
      const credentialId = credentialMatch[1] ?? "";
      const action = credentialMatch[2];
      let replacementFingerprint: `sha256:${string}` | null = null;
      if (action === "rotate") {
        const replacement = requireString(body, "apiKey", 8192);
        if (replacement.length < 8) throw new HttpProblem(400, "CREDENTIAL_TOO_SHORT", "Replacement credential must be at least 8 characters");
        const bytes = new TextEncoder().encode(replacement);
        try {
          replacementFingerprint = await fingerprintSecret(bytes);
        } finally {
          bytes.fill(0);
          body.apiKey = "[DESTROYED_AFTER_VAULT_INGRESS]";
        }
      }
      return mutate(`admin:${key}:${idempotency}`, () => {
        const store = getDemoStore();
        const credential = store.credentials.find((item) => item.id === credentialId);
        if (!credential) throw new HttpProblem(404, "CREDENTIAL_NOT_FOUND", "Credential version does not exist");
        if (action === "revoke") {
          credential.state = "REVOKED";
          appendDemoAudit("CREDENTIAL_REVOKE", credential.id, role, { newTokensIssued: false });
          return { id: credential.id, state: credential.state, newTokensIssued: false, plaintextRecoverable: false };
        }
        if (!replacementFingerprint) throw new HttpProblem(400, "REPLACEMENT_REQUIRED", "Rotation requires new credential material");
        if (replacementFingerprint === credential.fingerprint) throw new HttpProblem(409, "CREDENTIAL_REUSED", "Replacement credential must differ from the active version");
        credential.state = "PREVIOUS";
        const nextVersion = credential.version + 1;
        const replacement = {
          ...credential,
          id: credential.id.replace(/-v\d+$/, `-v${nextVersion}`),
          secretRef: credential.secretRef.replace(/#\d+$/, `#${nextVersion}`),
          fingerprint: replacementFingerprint,
          masked: maskFingerprint(replacementFingerprint),
          version: nextVersion,
          state: "ACTIVE" as const,
          createdAt: new Date().toISOString(),
        };
        store.credentials.push(replacement);
        appendDemoAudit("CREDENTIAL_ROTATE", credential.id, role, { replacementVersionId: replacement.id, newTasksOnly: true });
        return { id: replacement.id, previousId: credential.id, state: replacement.state, fingerprint: replacement.masked, newTokensIssued: true, oldVersionNoLongerIssued: true, plaintextRecoverable: false };
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

    throw new HttpProblem(404, "NOT_FOUND", `Unknown admin action: ${key}`);
  } catch (error) {
    return problemResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { segments } = await context.params;
    const key = routeKey(segments);
    const match = /^agent-defaults\/(platform|tenant:[a-z0-9-]+|project:[a-z0-9-]+)$/i.exec(key);
    if (!match) throw new HttpProblem(404, "NOT_FOUND", `Unknown admin resource: ${key}`);
    const role = requireRole(request, match[1]?.startsWith("platform") ? VERSION_ROLES : PROFILE_ROLES);
    const body = await bodyObject(request);
    const profileRevisionId = requireString(body, "profileRevisionId", 160);
    const result = withIdempotency(`admin:${key}:${idempotencyKey(request)}`, () => {
      const store = getDemoStore();
      const profile = store.profiles.find((item) => item.id === profileRevisionId && item.state === "ACTIVE");
      if (!profile) {
        throw new HttpProblem(409, "PROFILE_NOT_ACTIVE", "Defaults can only reference an active immutable Profile revision");
      }
      const scope = match[1] ?? "platform";
      const [scopeKind, scopeId = "global"] = scope.split(":");
      if (profile.scope !== scopeKind || (scopeKind !== "platform" && profile.scopeId !== scopeId)) {
        throw new HttpProblem(409, "PROFILE_SCOPE_MISMATCH", "Profile revision does not belong to the requested default scope");
      }
      store.defaults[match[1] ?? "platform"] = profileRevisionId;
      appendDemoAudit("AGENT_DEFAULT_UPDATED", match[1] ?? "platform", role, { profileRevisionId, affectsRunningTasks: false });
      return { scope: match[1], profileRevisionId, precedence: "project > tenant > platform > claude-code", affectsNewTasksOnly: true };
    });
    return json({ data: result.value, meta: { idempotentReplay: result.replayed } });
  } catch (error) {
    return problemResponse(error);
  }
}

function mutate<T>(idempotency: string, operation: () => T): Response {
  const result = withIdempotency(idempotency, operation);
  return json({ data: result.value, meta: { idempotentReplay: result.replayed } }, { status: result.replayed ? 200 : 201 });
}

function optionalModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
