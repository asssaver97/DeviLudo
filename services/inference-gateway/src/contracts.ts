import type { AgentKind, ModelRoles } from "../../../lib/agent/types";
import type { RunTokenBudget, RunTokenClaims } from "../../../lib/security/credentials";
import type { DnsResolver, ValidatedEndpoint } from "../../../lib/security/network";

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
  readonly state: "ACTIVE" | "DEGRADED" | "DISABLED";
}

export interface GatewayUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface RunAuthorizationRegistry {
  get(runId: string): Promise<ActiveRunAuthorization | null>;
}

export interface ProviderRevisionRegistry {
  get(providerRevisionId: string): Promise<GatewayProviderRevision | null>;
}

export interface UsageLedger {
  get(runId: string): Promise<GatewayUsage>;
}

export interface GatewayAuthorizationRequest {
  readonly token: string;
  readonly protocol: GatewayProtocol;
  readonly model: string;
  readonly nowEpochSeconds?: number;
}

export interface AuthorizedGatewayRequest {
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
  readonly body: unknown;
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
