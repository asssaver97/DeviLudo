import { createHash, randomBytes, randomUUID } from "node:crypto";
import { issueRunToken, type RunTokenClaims } from "../../../lib/security/credentials";
import type { SecretResolutionContext, SecretResolver } from "../../agent-worker/src/contracts";
import type {
  ActiveRunAuthorization,
  GatewayUsage,
  GatewayUsageClaimBinding,
  ProviderRevisionRegistry,
  RunAuthorizationRegistry,
  UsageLedger,
} from "../../inference-gateway/src/contracts";
import type { GatewayCredentialResolver } from "../../inference-gateway/src/production-connector";
import type { LocalAgentExecutionRequest } from "./contracts";
import type { LocalRunTokenBroker, PreparedLocalRunToken } from "./isolated-executor";
import { LocalProviderControl } from "./provider-control";

const TOKEN_TTL_SECONDS = 15 * 60;
const SECRET_REF = /^secret:\/\/local-run-token\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,420}$/;

type StoredToken = {
  readonly value: Buffer;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly expiresAtEpochSeconds: number;
};

type ClaimState =
  | Readonly<{ state: "ACTIVE"; binding: GatewayUsageClaimBinding; expiresAtEpochMs: number }>
  | Readonly<{ state: "INDETERMINATE"; binding: GatewayUsageClaimBinding }>;

/**
 * Process-local development implementation of the production run registry,
 * short-lived token broker and usage ledger. It never persists token or API-key
 * bytes and accepts only Provider revisions activated by LocalProviderControl.
 */
export class LocalInferenceAuthority implements LocalRunTokenBroker {
  readonly #providerControl: LocalProviderControl;
  readonly #signingKey: Uint8Array;
  readonly #now: () => Date;
  readonly #runs = new Map<string, ActiveRunAuthorization>();
  readonly #tokens = new Map<string, StoredToken>();
  readonly #usage = new Map<string, GatewayUsage>();
  readonly #claims = new Map<string, ClaimState>();

  readonly runs: RunAuthorizationRegistry = Object.freeze({
    get: async (tenantId: string, runId: string) => this.#snapshotRun(this.#runs.get(runKey(tenantId, runId))),
  });

  readonly providers: ProviderRevisionRegistry = Object.freeze({
    get: async (tenantId: string, providerRevisionId: string) =>
      this.#providerControl.providerForTenant(tenantId, providerRevisionId),
  });

  readonly usage: UsageLedger = Object.freeze({
    get: async (tenantId: string, runId: string) => this.#snapshotUsage(this.#usage.get(runKey(tenantId, runId))),
    claim: async (input: GatewayUsageClaimBinding) => this.#claim(input),
    complete: async (input: GatewayUsageClaimBinding & Readonly<{ usage: GatewayUsage }>) => this.#complete(input),
    release: async (input: GatewayUsageClaimBinding) => this.#release(input),
    abandon: async (input: GatewayUsageClaimBinding) => this.#abandon(input),
  });

  readonly credentials: GatewayCredentialResolver = Object.freeze({
    probe: async () => this.#providerControl.probeCredentialStore(),
    resolve: async (input: Readonly<{
      tenantId: string;
      projectId: string;
      runId: string;
      providerRevisionId: string;
      credentialVersionId: string;
    }>) => {
      const run = this.#runs.get(runKey(input.tenantId, input.runId));
      if (!run || run.state !== "ACTIVE" || run.projectId !== input.projectId
        || run.providerRevisionId !== input.providerRevisionId
        || run.credentialVersionId !== input.credentialVersionId) {
        throw new Error("Local run credential binding is unavailable");
      }
      return this.#providerControl.resolveCredential(input);
    },
  });

  readonly secrets: SecretResolver = Object.freeze({
    resolve: async (secretRef: string, context: SecretResolutionContext) => this.#resolveRunToken(secretRef, context),
  });

  constructor(
    providerControl: LocalProviderControl,
    options: Readonly<{ signingKey?: Uint8Array; now?: () => Date }> = {},
  ) {
    this.#providerControl = providerControl;
    this.#signingKey = options.signingKey ? Uint8Array.from(options.signingKey) : randomBytes(32);
    if (this.#signingKey.byteLength < 32) throw new Error("Local inference signing key is too short");
    this.#now = options.now ?? (() => new Date());
  }

  signingKey(): Uint8Array { return Uint8Array.from(this.#signingKey); }

  async issue(input: Readonly<{
    request: LocalAgentExecutionRequest;
    baseCommitSha: string;
  }>): Promise<PreparedLocalRunToken> {
    const { request } = input;
    if (!/^[a-f0-9]{40}$/.test(input.baseCommitSha)) throw new Error("Local run base commit is invalid");
    const provider = this.#providerControl.authorizeExecution(request);
    if (!provider || provider.protocol !== request.providerProtocol) {
      throw new Error("Local Provider is not active for this immutable run");
    }
    const key = runKey(request.tenantId, request.runId);
    const existing = this.#runs.get(key);
    if (existing?.state === "ACTIVE") throw new Error("Local run authorization is already active");
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (!Number.isSafeInteger(nowSeconds)) throw new Error("Local run clock is invalid");
    const authorizationExpiresAtEpochSeconds = nowSeconds + request.timeoutSeconds + 60;
    const models = Object.freeze([...new Set(Object.values(request.modelRoles))]);
    const budget = Object.freeze({
      maxCostUsd: request.budget.maxCostUsd,
      maxInputTokens: request.budget.maxInputTokens,
      maxOutputTokens: request.budget.maxOutputTokens,
    });
    const nonce = createHash("sha256").update([
      request.tenantId, request.projectId, request.runId, request.attemptId,
      request.profileRevisionId, input.baseCommitSha, randomUUID(),
    ].join("\0")).digest("hex");
    const claims: RunTokenClaims = Object.freeze({
      iss: "deviludo-control-plane",
      aud: "deviludo-inference-gateway",
      tenantId: request.tenantId,
      projectId: request.projectId,
      runId: request.runId,
      profileRevisionId: request.profileRevisionId,
      credentialVersionId: request.credentialVersionId,
      providerRevisionId: request.providerRevisionId,
      models,
      budget,
      iat: nowSeconds,
      exp: Math.min(nowSeconds + TOKEN_TTL_SECONDS, authorizationExpiresAtEpochSeconds),
      nonce,
    });
    const authorization: ActiveRunAuthorization = Object.freeze({
      tenantId: request.tenantId,
      projectId: request.projectId,
      runId: request.runId,
      profileRevisionId: request.profileRevisionId,
      providerRevisionId: request.providerRevisionId,
      credentialVersionId: request.credentialVersionId,
      models,
      budget,
      nonce,
      state: "ACTIVE",
    });
    const secretRef = `secret://local-run-token/${encodeURIComponent(request.tenantId)}/${encodeURIComponent(request.runId)}/${encodeURIComponent(request.attemptId)}`;
    if (!SECRET_REF.test(secretRef)) throw new Error("Local run SecretRef is invalid");
    const token = Buffer.from(await issueRunToken(this.#signingKey, claims), "utf8");
    this.#runs.set(key, authorization);
    this.#usage.set(key, Object.freeze({ inputTokens: 0, outputTokens: 0, costUsd: 0 }));
    this.#tokens.set(secretRef, Object.freeze({
      value: token,
      tenantId: request.tenantId,
      projectId: request.projectId,
      runId: request.runId,
      attemptId: request.attemptId,
      expiresAtEpochSeconds: claims.exp,
    }));
    let revoked = false;
    let currentExpiry = claims.exp;
    let renewal: Promise<Readonly<{ expiresAt: string; renewed: boolean }>> | null = null;
    return Object.freeze({
      secretRef,
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
      renew: async () => {
        if (revoked) throw new Error("Local run authorization is unavailable");
        const remaining = currentExpiry - Math.floor(this.#now().getTime() / 1_000);
        if (Number.isFinite(remaining) && remaining > 5 * 60) {
          return Object.freeze({ expiresAt: new Date(currentExpiry * 1_000).toISOString(), renewed: false });
        }
        renewal ??= this.#renew(secretRef, request, claims, authorizationExpiresAtEpochSeconds).then((expiresAtEpochSeconds) => {
          currentExpiry = expiresAtEpochSeconds;
          return Object.freeze({
            expiresAt: new Date(expiresAtEpochSeconds * 1_000).toISOString(),
            renewed: true,
          });
        }).finally(() => { renewal = null; });
        return renewal;
      },
      revoke: async () => {
        if (revoked) return;
        revoked = true;
        if (renewal) {
          try { await renewal; }
          catch { /* Revocation still wins over a failed concurrent renewal. */ }
        }
        this.#revoke(secretRef, key);
      },
    });
  }

  close(): void {
    for (const token of this.#tokens.values()) token.value.fill(0);
    this.#tokens.clear();
    this.#runs.clear();
    this.#usage.clear();
    this.#claims.clear();
    this.#signingKey.fill(0);
  }

  #resolveRunToken(secretRef: string, context: Readonly<{
    runId: string;
    attemptId: string;
    environmentVariable: string;
  }>): string {
    const stored = this.#tokens.get(secretRef);
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (!stored || stored.runId !== context.runId || stored.attemptId !== context.attemptId
      || stored.expiresAtEpochSeconds <= nowSeconds
      || (context.environmentVariable !== "ANTHROPIC_API_KEY" && context.environmentVariable !== "DEVILUDO_RUN_TOKEN")) {
      throw new Error("Local run SecretRef is unavailable");
    }
    const run = this.#runs.get(runKey(stored.tenantId, stored.runId));
    if (!run || run.state !== "ACTIVE" || run.projectId !== stored.projectId) {
      throw new Error("Local run authorization is unavailable");
    }
    return stored.value.toString("utf8");
  }

  async #renew(
    secretRef: string,
    request: LocalAgentExecutionRequest,
    previous: RunTokenClaims,
    authorizationExpiresAtEpochSeconds: number,
  ): Promise<number> {
    const stored = this.#tokens.get(secretRef);
    const provider = this.#providerControl.authorizeExecution(request);
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (!stored || !provider || provider.protocol !== request.providerProtocol
      || !Number.isSafeInteger(nowSeconds)) {
      throw new Error("Local run authorization cannot be renewed");
    }
    const run = this.#runs.get(runKey(request.tenantId, request.runId));
    if (!run || run.state !== "ACTIVE" || run.nonce !== previous.nonce
      || stored.tenantId !== request.tenantId || stored.projectId !== request.projectId
      || stored.runId !== request.runId || stored.attemptId !== request.attemptId) {
      throw new Error("Local run authorization cannot be renewed");
    }
    const expiresAtEpochSeconds = Math.min(nowSeconds + TOKEN_TTL_SECONDS, authorizationExpiresAtEpochSeconds);
    if (expiresAtEpochSeconds <= nowSeconds + 30) {
      throw new Error("Local run authorization cannot be renewed");
    }
    const claims: RunTokenClaims = Object.freeze({
      ...previous,
      iat: nowSeconds,
      exp: expiresAtEpochSeconds,
    });
    const value = Buffer.from(await issueRunToken(this.#signingKey, claims), "utf8");
    const current = this.#tokens.get(secretRef);
    if (current !== stored) {
      value.fill(0);
      throw new Error("Local run authorization changed during renewal");
    }
    stored.value.fill(0);
    this.#tokens.set(secretRef, Object.freeze({
      ...stored,
      value,
      expiresAtEpochSeconds: claims.exp,
    }));
    return claims.exp;
  }

  #claim(input: GatewayUsageClaimBinding): "ACQUIRED" | "BUSY" | "INDETERMINATE" | "BUDGET_EXHAUSTED" {
    const key = runKey(input.tenantId, input.runId);
    const run = this.#runs.get(key);
    if (!run || run.state !== "ACTIVE" || !claimMatchesRun(input, run)) return "INDETERMINATE";
    const current = this.#claims.get(key);
    if (current?.state === "INDETERMINATE") return "INDETERMINATE";
    if (current?.state === "ACTIVE") {
      if (current.expiresAtEpochMs <= this.#now().getTime()) {
        this.#claims.set(key, Object.freeze({ state: "INDETERMINATE", binding: current.binding }));
        return "INDETERMINATE";
      }
      return "BUSY";
    }
    const used = this.#snapshotUsage(this.#usage.get(key));
    if (used.costUsd >= run.budget.maxCostUsd
      || (run.budget.maxInputTokens !== undefined && used.inputTokens >= run.budget.maxInputTokens)
      || (run.budget.maxOutputTokens !== undefined && used.outputTokens >= run.budget.maxOutputTokens)) {
      return "BUDGET_EXHAUSTED";
    }
    this.#claims.set(key, Object.freeze({
      state: "ACTIVE",
      binding: Object.freeze({ ...input }),
      expiresAtEpochMs: this.#now().getTime() + input.leaseSeconds * 1_000,
    }));
    return "ACQUIRED";
  }

  #complete(input: GatewayUsageClaimBinding & Readonly<{ usage: GatewayUsage }>): void {
    const key = runKey(input.tenantId, input.runId);
    this.#assertClaim(key, input);
    validUsage(input.usage);
    const current = this.#snapshotUsage(this.#usage.get(key));
    this.#usage.set(key, Object.freeze({
      inputTokens: current.inputTokens + input.usage.inputTokens,
      outputTokens: current.outputTokens + input.usage.outputTokens,
      costUsd: current.costUsd + input.usage.costUsd,
    }));
    this.#claims.delete(key);
  }

  #release(input: GatewayUsageClaimBinding): void {
    const key = runKey(input.tenantId, input.runId);
    this.#assertClaim(key, input);
    this.#claims.delete(key);
  }

  #abandon(input: GatewayUsageClaimBinding): void {
    const key = runKey(input.tenantId, input.runId);
    this.#assertClaim(key, input);
    this.#claims.set(key, Object.freeze({ state: "INDETERMINATE", binding: Object.freeze({ ...input }) }));
  }

  #assertClaim(key: string, input: GatewayUsageClaimBinding): void {
    const current = this.#claims.get(key);
    if (!current || current.state !== "ACTIVE" || !sameClaim(current.binding, input)) {
      throw new Error("Local inference usage claim is invalid");
    }
  }

  #revoke(secretRef: string, key: string): void {
    const token = this.#tokens.get(secretRef);
    token?.value.fill(0);
    this.#tokens.delete(secretRef);
    const run = this.#runs.get(key);
    if (run) this.#runs.set(key, Object.freeze({ ...run, state: "COMPLETED" }));
    this.#claims.delete(key);
  }

  #snapshotRun(run: ActiveRunAuthorization | undefined): ActiveRunAuthorization | null {
    return run ? Object.freeze({ ...run, models: Object.freeze([...run.models]), budget: Object.freeze({ ...run.budget }) }) : null;
  }

  #snapshotUsage(usage: GatewayUsage | undefined): GatewayUsage {
    return Object.freeze({ ...(usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }) });
  }
}

function runKey(tenantId: string, runId: string): string { return `${tenantId}\0${runId}`; }

function claimMatchesRun(input: GatewayUsageClaimBinding, run: ActiveRunAuthorization): boolean {
  return input.projectId === run.projectId
    && input.providerRevisionId === run.providerRevisionId
    && input.credentialVersionId === run.credentialVersionId
    && run.models.includes(input.model)
    && Number.isSafeInteger(input.leaseSeconds) && input.leaseSeconds > 0 && input.leaseSeconds <= 15 * 60;
}

function sameClaim(left: GatewayUsageClaimBinding, right: GatewayUsageClaimBinding): boolean {
  return left.requestId === right.requestId && left.claimToken === right.claimToken
    && left.tenantId === right.tenantId && left.projectId === right.projectId && left.runId === right.runId
    && left.providerRevisionId === right.providerRevisionId
    && left.credentialVersionId === right.credentialVersionId && left.model === right.model;
}

function validUsage(value: GatewayUsage): void {
  if (!Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0
    || !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0
    || !Number.isFinite(value.costUsd) || value.costUsd < 0) {
    throw new Error("Local inference usage is invalid");
  }
}
