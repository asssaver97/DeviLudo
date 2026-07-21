import type { DnsResolver } from "../../../lib/security/network";
import type { PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { SpecDialogueMessage, SpecModelResult } from "../../spec-dialogue/src/contracts";

export type SpecModelProtocol = "anthropic-messages" | "openai-responses";

export interface SpecGenerationRequest {
  readonly schemaVersion: "deviludo.spec-generation.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly history: readonly SpecDialogueMessage[];
  readonly current: SpecModelResult | null;
  readonly userMessage: string;
  readonly outputSchema: "deviludo.spec-model-result.v1";
  readonly toolsAllowed: false;
}

export interface SpecModelProviderBinding {
  readonly profileRevisionId: string;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly agent: "claude-code" | "codex-cli";
  readonly protocol: SpecModelProtocol;
  readonly baseUrl: string;
  readonly approvedPorts: readonly number[];
  readonly authentication: "bearer" | "x-api-key" | "authorization-bearer";
  readonly model: string;
  readonly policyDigest: string;
}

export interface SpecModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SpecGenerationReceipt {
  readonly result: SpecModelResult;
  readonly usage: SpecModelUsage;
}

export interface SpecModelProviderAuthority {
  resolve(profileRevisionId: string): Promise<SpecModelProviderBinding>;
  probe(): Promise<void>;
}

export interface SpecModelCredentialLease {
  readonly value: Uint8Array;
  destroy(): void;
}

export interface SpecModelCredentialResolver {
  resolve(binding: SpecModelProviderBinding): Promise<SpecModelCredentialLease>;
  probe(): Promise<void>;
}

export interface SpecModelGenerator {
  generate(input: Readonly<{
    operationKey: string;
    request: SpecGenerationRequest;
    provider: SpecModelProviderBinding;
  }>): Promise<SpecGenerationReceipt>;
  probe(): Promise<void>;
}

export type SpecModelOperationLookup =
  | Readonly<{ kind: "COMPLETED"; result: SpecModelResult }>
  | Readonly<{ kind: "BUSY" | "INDETERMINATE" }>
  | Readonly<{ kind: "RETRY" }>
  | null;

export type SpecModelOperationClaim =
  | Readonly<{ kind: "CLAIMED"; claimToken: string }>
  | Readonly<{ kind: "COMPLETED"; result: SpecModelResult }>
  | Readonly<{ kind: "BUSY" | "INDETERMINATE" }>;

export interface SpecModelOperationStore {
  lookup(input: Readonly<{
    tenantId: string;
    projectId: string;
    conversationId: string;
    operationKey: string;
    requestDigest: string;
  }>): Promise<SpecModelOperationLookup>;
  claim(input: Readonly<{
    tenantId: string;
    projectId: string;
    conversationId: string;
    operationKey: string;
    requestDigest: string;
    provider: SpecModelProviderBinding;
    claimToken: string;
    leaseSeconds: number;
  }>): Promise<SpecModelOperationClaim>;
  complete(input: Readonly<{
    tenantId: string;
    operationKey: string;
    claimToken: string;
    result: SpecModelResult;
    usage: SpecModelUsage;
  }>): Promise<void>;
  release(input: Readonly<{ tenantId: string; operationKey: string; claimToken: string }>): Promise<void>;
  abandon(input: Readonly<{ tenantId: string; operationKey: string; claimToken: string }>): Promise<void>;
  probe(): Promise<void>;
}

export interface SpecModelRuntimeDependencies {
  readonly pool: PostgresWorkflowPool;
  readonly dns: DnsResolver;
}

export class SpecModelRequestError extends Error {}
export class SpecModelBusyError extends Error {}
export class SpecModelIndeterminateError extends Error {}
export class SpecModelProviderUnavailableError extends Error {}

export class SpecModelUpstreamError extends Error {
  constructor(readonly dispatched: boolean) {
    super("Specification model upstream request failed");
  }
}
