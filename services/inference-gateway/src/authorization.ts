import { verifyRunTokenIntegrity, type RunTokenBudget, type RunTokenClaims } from "../../../lib/security/credentials";
import { validateEndpointForConnection } from "../../../lib/security/network";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import type {
  ActiveRunAuthorization,
  AuthorizedGatewayRequest,
  GatewayAuthorizationRequest,
  GatewayProviderRevision,
  GatewayUsage,
  InferenceGatewayAuthorizerOptions,
} from "./contracts";

export class GatewayAuthorizationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 403) {
    super(message);
  }
}

export class InferenceGatewayAuthorizer {
  readonly #options: InferenceGatewayAuthorizerOptions;

  constructor(options: InferenceGatewayAuthorizerOptions) {
    if (options.signingKey.byteLength < 32) throw new Error("Inference Gateway signing key is too short");
    this.#options = { ...options, signingKey: Uint8Array.from(options.signingKey) };
  }

  async authorize(request: GatewayAuthorizationRequest): Promise<AuthorizedGatewayRequest> {
    let claims: RunTokenClaims;
    try {
      claims = await verifyRunTokenIntegrity(this.#options.signingKey, request.token, request.nowEpochSeconds);
    } catch {
      throw new GatewayAuthorizationError("INVALID_RUN_TOKEN", "Run token is invalid or expired", 401);
    }

    const storedRun = await this.#options.runs.get(claims.tenantId, claims.runId);
    if (!storedRun) throw new GatewayAuthorizationError("RUN_BINDING_MISMATCH", "Run authorization is not active");
    const run = snapshotRun(storedRun);
    if (run.state !== "ACTIVE" || !sameRunBinding(claims, run)) {
      throw new GatewayAuthorizationError("RUN_BINDING_MISMATCH", "Run authorization is not active");
    }

    let model: string;
    try {
      model = assertPinnedModelId(request.model);
    } catch {
      throw new GatewayAuthorizationError("MODEL_NOT_ALLOWED", "Requested model is not an approved exact model");
    }
    if (!claims.models.includes(model) || !run.models.includes(model)) {
      throw new GatewayAuthorizationError("MODEL_NOT_ALLOWED", "Requested model is outside the run allowlist");
    }

    const storedProvider = await this.#options.providers.get(claims.tenantId, claims.providerRevisionId);
    if (!storedProvider) throw new GatewayAuthorizationError("PROVIDER_UNAVAILABLE", "Locked Provider revision is unavailable", 409);
    const provider = snapshotProvider(storedProvider);
    if (!providerMatches(provider, claims, request.protocol, model)) {
      throw new GatewayAuthorizationError("PROVIDER_UNAVAILABLE", "Locked Provider revision is unavailable", 409);
    }

    const usage = Object.freeze({ ...await this.#options.usage.get(claims.tenantId, claims.runId) });
    const remainingBudget = remaining(claims.budget, usage);
    if (remainingBudget.maxCostUsd <= 0 || remainingBudget.maxInputTokens === 0 || remainingBudget.maxOutputTokens === 0) {
      throw new GatewayAuthorizationError("RUN_BUDGET_EXHAUSTED", "Run inference budget is exhausted", 429);
    }

    let endpoint;
    try {
      endpoint = await validateEndpointForConnection(provider.baseUrl, this.#options.dns, {
        approvedPorts: provider.approvedPorts,
        maxRedirects: 3,
      });
    } catch {
      throw new GatewayAuthorizationError("PROVIDER_ENDPOINT_BLOCKED", "Provider endpoint failed network policy", 409);
    }

    return Object.freeze({
      model,
      claims,
      run,
      provider,
      endpoint,
      usage,
      remainingBudget,
    });
  }
}

function snapshotRun(run: ActiveRunAuthorization): ActiveRunAuthorization {
  return Object.freeze({
    ...run,
    models: Object.freeze([...run.models]),
    budget: Object.freeze({ ...run.budget }),
  });
}

function snapshotProvider(provider: GatewayProviderRevision): GatewayProviderRevision {
  return Object.freeze({
    ...provider,
    approvedPorts: Object.freeze([...provider.approvedPorts]),
    models: Object.freeze({ ...provider.models }),
    pricing: Object.freeze({ ...provider.pricing }),
  });
}

function sameRunBinding(claims: RunTokenClaims, run: ActiveRunAuthorization): boolean {
  return claims.tenantId === run.tenantId
    && claims.projectId === run.projectId
    && claims.runId === run.runId
    && claims.profileRevisionId === run.profileRevisionId
    && claims.providerRevisionId === run.providerRevisionId
    && claims.credentialVersionId === run.credentialVersionId
    && claims.nonce === run.nonce
    && sameStrings(claims.models, run.models)
    && sameBudget(claims.budget, run.budget);
}

function providerMatches(provider: GatewayProviderRevision, claims: RunTokenClaims, protocol: GatewayAuthorizationRequest["protocol"], model: string): boolean {
  return validPricing(provider.pricing)
    && provider.state === "ACTIVE"
    && provider.protocol === protocol
    && provider.providerRevisionId === claims.providerRevisionId
    && provider.credentialVersionId === claims.credentialVersionId
    && Object.values(provider.models).includes(model)
    && ((protocol === "openai-responses" && provider.agent === "codex-cli")
      || (protocol === "anthropic-messages" && provider.agent === "claude-code"));
}

function validPricing(value: GatewayProviderRevision["pricing"]): boolean {
  return Number.isFinite(value.inputUsdPerMillionTokens) && value.inputUsdPerMillionTokens >= 0
    && Number.isFinite(value.outputUsdPerMillionTokens) && value.outputUsdPerMillionTokens >= 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBudget(left: RunTokenBudget, right: RunTokenBudget): boolean {
  return left.maxCostUsd === right.maxCostUsd
    && left.maxInputTokens === right.maxInputTokens
    && left.maxOutputTokens === right.maxOutputTokens;
}

function remaining(budget: RunTokenBudget, usage: GatewayUsage): RunTokenBudget {
  validateUsage(usage);
  return Object.freeze({
    maxCostUsd: Math.max(0, budget.maxCostUsd - usage.costUsd),
    ...(budget.maxInputTokens === undefined ? {} : { maxInputTokens: Math.max(0, budget.maxInputTokens - usage.inputTokens) }),
    ...(budget.maxOutputTokens === undefined ? {} : { maxOutputTokens: Math.max(0, budget.maxOutputTokens - usage.outputTokens) }),
  });
}

function validateUsage(usage: GatewayUsage): void {
  if (!Number.isInteger(usage.inputTokens) || usage.inputTokens < 0
    || !Number.isInteger(usage.outputTokens) || usage.outputTokens < 0
    || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    throw new GatewayAuthorizationError("INVALID_USAGE_LEDGER", "Run usage ledger is invalid", 503);
  }
}
