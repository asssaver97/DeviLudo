import type { AgentKind, ModelRoles } from "../../../lib/agent/types";
import type { RunTokenBudget, RunTokenClaims } from "../../../lib/security/credentials";
import type { DnsResolver, ValidatedEndpoint } from "../../../lib/security/network";
import type { Readable } from "node:stream";

export type GatewayProtocol = "openai-responses" | "anthropic-messages";

export interface ActiveRunAuthorization {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly profileRevisionId: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly models: readonly string[];
  readonly budget: RunTokenBudget;
  readonly nonce: string;
  readonly state: "ACTIVE" | "REVOKED" | "COMPLETED";
}

export interface GatewayProviderRevision {
  readonly providerRevisionId: string;
  readonly agent: AgentKind;
  readonly protocol: GatewayProtocol;
  readonly baseUrl: string;
  readonly approvedPorts: readonly number[];
  readonly authentication: "bearer" | "x-api-key" | "authorization-bearer";
  readonly models: ModelRoles;
  readonly credentialVersionId: string;
  readonly pricing: Readonly<{
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  }>;
  readonly state: "ACTIVE" | "DEGRADED" | "DISABLED";
}

export interface GatewayUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface RunAuthorizationRegistry {
  get(tenantId: string, runId: string): Promise<ActiveRunAuthorization | null>;
}

export interface ProviderRevisionRegistry {
  get(tenantId: string, providerRevisionId: string): Promise<GatewayProviderRevision | null>;
}

export interface UsageLedger {
  get(tenantId: string, runId: string): Promise<GatewayUsage>;
  claim(input: GatewayUsageClaimBinding): Promise<"ACQUIRED" | "BUSY" | "INDETERMINATE" | "BUDGET_EXHAUSTED">;
  complete(input: GatewayUsageClaimBinding & Readonly<{ usage: GatewayUsage }>): Promise<void>;
  release(input: GatewayUsageClaimBinding): Promise<void>;
  abandon(input: GatewayUsageClaimBinding): Promise<void>;
}

export interface GatewayUsageClaimBinding {
  readonly requestId: string;
  readonly claimToken: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly model: string;
  readonly leaseSeconds: number;
}

export type InferenceReconciliationAction = "CONFIRM_NO_USAGE" | "RECORD_USAGE";

export interface InferenceReconciliationRequest {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly action: InferenceReconciliationAction;
  readonly evidenceDigest: string;
  readonly reconciledBy: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface InferenceReconciliationReceipt {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly action: InferenceReconciliationAction;
  readonly evidenceDigest: string;
  readonly state: "COMPLETED" | "RELEASED";
  readonly usage: GatewayUsage;
  readonly reconciledAt: string;
}

export interface InferenceReconciliationStatus {
  readonly tenantId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly providerRevisionId: string;
  readonly model: string;
  readonly state: "ACTIVE" | "INDETERMINATE";
  readonly claimExpiresAt: string;
  readonly createdAt: string;
}

export interface InferenceReconciliationStore {
  lookup(tenantId: string, runId: string): Promise<InferenceReconciliationStatus | null>;
  reconcile(input: InferenceReconciliationRequest): Promise<InferenceReconciliationReceipt>;
}

export interface GatewayAuthorizationRequest {
  readonly token: string;
  readonly protocol: GatewayProtocol;
  readonly model: string;
  readonly nowEpochSeconds?: number;
}

export interface AuthorizedGatewayRequest {
  readonly model: string;
  readonly claims: RunTokenClaims;
  readonly run: ActiveRunAuthorization;
  readonly provider: GatewayProviderRevision;
  readonly endpoint: ValidatedEndpoint;
  readonly usage: GatewayUsage;
  readonly remainingBudget: RunTokenBudget;
}

export interface InferenceGatewayAuthorizerOptions {
  readonly signingKey: Uint8Array;
  readonly runs: RunAuthorizationRegistry;
  readonly providers: ProviderRevisionRegistry;
  readonly usage: UsageLedger;
  readonly dns: DnsResolver;
}

export interface GatewayConnectorResponse {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown | Buffer | Readable;
}

/**
 * Trusted connector boundary: it resolves the exact credential version and
 * connects only to endpoint.connectAddresses. The gateway never accepts a raw
 * upstream key from an HTTP request or persisted run payload.
 */
export interface GatewayConnector {
  forward(input: {
    readonly authorization: AuthorizedGatewayRequest;
    readonly body: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
  }): Promise<GatewayConnectorResponse>;
}
