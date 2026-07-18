import type {
  AgentInstallationBuildReceipt,
  AgentInstallationRolloutReceipt,
  AgentSupplyChainTerminalFailureReceipt,
  AgentVersionCandidateReceipt,
  AgentVersionValidationReceipt,
} from "../../control-plane/src/agent-supply-chain";
export type { AgentSupplyChainTerminalFailureReceipt } from "../../control-plane/src/agent-supply-chain";
import type { AgentKind } from "../../control-plane/src/contracts";

export interface AgentSupplyChainOperationBinding {
  readonly operationKey: string;
  readonly requestDigest: string;
}

export interface AgentVersionDiscoveryRequest extends AgentSupplyChainOperationBinding {
  readonly schemaVersion: "deviludo.agent-version-discovery-request.v1";
  readonly agent: AgentKind;
  readonly requestedVersion: string | null;
}

export interface AgentVersionValidationRequest extends AgentSupplyChainOperationBinding {
  readonly schemaVersion: "deviludo.agent-version-validation-request.v1";
  readonly candidate: AgentVersionCandidateReceipt;
}

export interface AgentInstallationBuildRequest extends AgentSupplyChainOperationBinding {
  readonly schemaVersion: "deviludo.agent-installation-build-request.v1";
  readonly installationId: string;
  readonly candidate: AgentVersionCandidateReceipt;
  readonly validation: AgentVersionValidationReceipt;
  readonly workerPool: string;
  readonly adapterVersion: string;
  readonly rollbackInstallationId: string | null;
}

export interface AgentInstallationRolloutRequest extends AgentSupplyChainOperationBinding {
  readonly schemaVersion: "deviludo.agent-installation-rollout-request.v1";
  readonly installationId: string;
  readonly imageDigest: string;
  readonly action: "ADVANCE" | "ROLLBACK";
  readonly fromPercent: 0 | 5 | 25 | 100;
  readonly toPercent: 0 | 5 | 25 | 100;
}

export type AgentSupplyChainRequest =
  | AgentVersionDiscoveryRequest
  | AgentVersionValidationRequest
  | AgentInstallationBuildRequest
  | AgentInstallationRolloutRequest;

export interface AgentVersionDiscoveryResponse {
  readonly schemaVersion: "deviludo.agent-version-discovery-receipt.v1";
  readonly candidates: readonly AgentVersionCandidateReceipt[];
}

export type AgentSupplyChainResponse =
  | AgentVersionDiscoveryResponse
  | AgentVersionValidationReceipt
  | AgentInstallationBuildReceipt
  | AgentInstallationRolloutReceipt;

export type AgentSupplyChainOperationKind = "DISCOVER" | "VALIDATE" | "BUILD" | "ROLLOUT";

export type AgentSupplyChainOperationResult = AgentSupplyChainResponse | AgentSupplyChainTerminalFailureReceipt;

export interface AgentSupplyChainNativeExecutor {
  execute(request: AgentSupplyChainRequest): Promise<AgentSupplyChainResponse>;
  probe(): Promise<void>;
}

export interface AgentSupplyChainOperationPersistence {
  claim(input: Readonly<{
    operationKey: string;
    requestDigest: string;
    kind: AgentSupplyChainOperationKind;
    payloadDigest: string;
    request: AgentSupplyChainRequest;
    claimToken: string;
    claimedAt: string;
    claimExpiresAt: string;
  }>): Promise<
    | Readonly<{ kind: "ACQUIRED"; attempt: number }>
    | Readonly<{ kind: "BUSY" }>
    | Readonly<{ kind: "REPLAY"; response: AgentSupplyChainOperationResult }>
  >;
  complete(input: Readonly<{
    operationKey: string;
    claimToken: string;
    response: AgentSupplyChainOperationResult;
    responseDigest: string;
    completedAt: string;
  }>): Promise<void>;
  release(input: Readonly<{
    operationKey: string;
    claimToken: string;
    releasedAt: string;
  }>): Promise<void>;
  probe(): Promise<void>;
}
