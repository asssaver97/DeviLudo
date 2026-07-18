import { randomUUID } from "node:crypto";
import type { AgentWorkflowRunReceipt } from "../../agent-worker/src/workflow-handler";
import type {
  AgentExecutionBrokerIdentity,
  AgentExecutionLookup,
  AgentExecutionRequest,
  AgentExecutionStatus,
  IsolatedAgentExecutionRequest,
  IsolatedAgentExecutionResult,
  LockedAgentExecution,
} from "./contracts";
import { parseAgentExecutionRequest, validateAgentExecutionStatus, validateIsolatedResult } from "./contracts";
import { AgentRunAuthorizationUnavailableError, HmacEphemeralRunTokenBroker } from "./token-broker";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LEASE_MS = 5 * 60_000;

export class AgentProviderUnavailable extends Error {
  constructor(readonly providerRevisionId: string) { super("Agent Provider is unavailable"); }
}

export interface AgentExecutionOperationPersistence {
  reserve(input: Readonly<{ submitterSpiffeId: string; request: AgentExecutionRequest; createdAt: string }> ):
    Promise<Readonly<{ created: boolean; status: AgentExecutionStatus }>>;
  find(lookup: AgentExecutionLookup): Promise<AgentExecutionStatus>;
  claim(input: Readonly<{ tenantId: string; runId: string; claimToken: string; claimedAt: string; claimExpiresAt: string }> ):
    Promise<Readonly<{ kind: "ACQUIRED"; request: AgentExecutionRequest; lock: LockedAgentExecution; attemptId: string; attempt: number }>
      | Readonly<{ kind: "BUSY" | "TERMINAL"; status: AgentExecutionStatus }>>;
  heartbeat(input: Readonly<{ tenantId: string; runId: string; claimToken: string; heartbeatAt: string; claimExpiresAt: string }>): Promise<void>;
  complete(input: Readonly<{ tenantId: string; runId: string; claimToken: string; result: IsolatedAgentExecutionResult;
    receipt: AgentWorkflowRunReceipt; completedAt: string }>): Promise<AgentExecutionStatus>;
  waitForProvider(input: Readonly<{ tenantId: string; runId: string; claimToken: string; providerRevisionId: string;
    observedAt: string }>): Promise<void>;
  release(input: Readonly<{ tenantId: string; runId: string; claimToken: string; releasedAt: string; retryAt: string }>): Promise<void>;
  probe(): Promise<void>;
}

export interface AgentExecutionOperationDispatcher {
  enqueue(input: Readonly<{ tenantId: string; runId: string; operationKey: string; requestDigest: string }>): Promise<void>;
  probe(): Promise<void>;
}

/** This connector crosses into the isolated development Worker pool; it receives only an ephemeral SecretRef. */
export interface IsolatedAgentExecutionDispatcher {
  execute(request: IsolatedAgentExecutionRequest, context: Readonly<{ heartbeat(): Promise<void> }>): Promise<IsolatedAgentExecutionResult>;
  probe(): Promise<void>;
}

export class DurableAgentExecutionService {
  constructor(
    private readonly operations: AgentExecutionOperationPersistence,
    private readonly dispatcher: AgentExecutionOperationDispatcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async submit(identity: AgentExecutionBrokerIdentity, value: AgentExecutionRequest): Promise<AgentExecutionStatus> {
    const request = parseAgentExecutionRequest(value);
    const submitterSpiffeId = validateIdentity(identity);
    const reserved = await this.operations.reserve({ submitterSpiffeId, request, createdAt: validNow(this.now()).toISOString() });
    if (reserved.status.status === "RUNNING") {
      await this.dispatcher.enqueue({ tenantId: request.tenantId, runId: request.lockedRunConfigurationId,
        operationKey: request.operationKey, requestDigest: request.requestDigest });
    }
    return validateAgentExecutionStatus(reserved.status, request);
  }

  async get(identity: AgentExecutionBrokerIdentity, lookup: AgentExecutionLookup): Promise<AgentExecutionStatus> {
    validateIdentity(identity);
    validateLookup(lookup);
    return validateAgentExecutionStatus(await this.operations.find(lookup), { lockedRunConfigurationId: lookup.runId });
  }

  async probe(): Promise<void> { await Promise.all([this.operations.probe(), this.dispatcher.probe()]); }
}

/** Queue consumer. A lost lease cannot commit a stale microVM result. */
export class AgentExecutionOperationWorker {
  constructor(
    private readonly operations: AgentExecutionOperationPersistence,
    private readonly tokens: HmacEphemeralRunTokenBroker,
    private readonly executor: IsolatedAgentExecutionDispatcher,
    private readonly options: Readonly<{ now?: () => Date; claimToken?: () => string; leaseMs?: number }> = {},
  ) {}

  async execute(input: Readonly<{ tenantId: string; runId: string }>): Promise<AgentExecutionStatus | null> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.runId)) invalid();
    const now = this.options.now ?? (() => new Date());
    const claimToken = (this.options.claimToken ?? randomUUID)();
    if (!UUID.test(claimToken)) invalid();
    const leaseMs = boundedLease(this.options.leaseMs ?? LEASE_MS);
    const claimedAt = validNow(now());
    let claim;
    try {
      claim = await this.operations.claim({ ...input, claimToken, claimedAt: claimedAt.toISOString(),
        claimExpiresAt: new Date(claimedAt.getTime() + leaseMs).toISOString() });
    } catch (error) {
      if (error instanceof AgentProviderUnavailable) return null;
      throw error;
    }
    if (claim.kind !== "ACQUIRED") return claim.status;
    let prepared;
    try {
      prepared = await this.tokens.prepare(claim.lock, claim.attemptId);
    } catch (error) {
      if (error instanceof AgentRunAuthorizationUnavailableError) {
        await this.operations.waitForProvider({ ...input, claimToken, providerRevisionId: error.providerRevisionId,
          observedAt: validNow(now()).toISOString() });
        return null;
      }
      await this.operations.release({ ...input, claimToken, ...retryWindow(validNow(now()), claim.attempt) });
      throw error;
    }
    try {
      const result = validateIsolatedResult(await this.executor.execute(Object.freeze({
        ...claim.lock,
        attemptId: claim.attemptId,
        inferenceTokenSecretRef: prepared.secretRef,
        inferenceTokenExpiresAt: prepared.expiresAt,
      }), { heartbeat: async () => {
        const heartbeatAt = validNow(now());
        await this.operations.heartbeat({ ...input, claimToken, heartbeatAt: heartbeatAt.toISOString(),
          claimExpiresAt: new Date(heartbeatAt.getTime() + leaseMs).toISOString() });
      } }), claim.lock, claim.attemptId);
      const receipt = workflowReceipt(result, claim.lock);
      return await this.operations.complete({ ...input, claimToken, result, receipt, completedAt: validNow(now()).toISOString() });
    } catch (error) {
      await this.operations.release({ ...input, claimToken, ...retryWindow(validNow(now()), claim.attempt) });
      throw error;
    } finally {
      await prepared.revoke();
    }
  }

  async probe(): Promise<void> { await Promise.all([this.operations.probe(), this.tokens.probe(), this.executor.probe()]); }
}

function workflowReceipt(result: IsolatedAgentExecutionResult, lock: LockedAgentExecution): AgentWorkflowRunReceipt {
  return Object.freeze({
    status: result.status,
    runId: lock.runId,
    lockedRunConfigurationId: lock.runId,
    agent: lock.agent,
    profileRevisionId: lock.profileRevisionId,
    installationId: lock.installationId,
    imageDigest: lock.imageDigest,
    providerRevisionId: lock.providerRevisionId,
    model: lock.model,
    candidateCommitSha: result.candidateCommitSha,
    draftPullRequest: result.draftPullRequest,
    diagnosticId: result.diagnosticId,
    receiptId: result.receiptId,
  });
}

function validateIdentity(identity: AgentExecutionBrokerIdentity): string {
  if (!identity || typeof identity !== "object" || typeof identity.spiffeId !== "string" || identity.spiffeId.length > 512) invalid();
  const url = new URL(identity.spiffeId);
  if (url.protocol !== "spiffe:" || !url.hostname || url.pathname === "/" || url.username || url.password || url.search || url.hash) invalid();
  return url.toString();
}
function validateLookup(value: AgentExecutionLookup): void {
  if (!UUID.test(value.tenantId) || !UUID.test(value.runId)
    || !/^workflow-job:[a-f0-9-]{36}$/i.test(value.operationKey) || !/^[a-f0-9]{64}$/.test(value.requestDigest)) invalid();
}
function boundedLease(value: number): number { if (!Number.isInteger(value) || value < 30_000 || value > 15 * 60_000) invalid(); return value; }
function validNow(value: Date): Date { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(); return value; }
function retryWindow(now: Date, attempt: number): Readonly<{ releasedAt: string; retryAt: string }> {
  const delayMs = Math.min(15 * 60_000, 5_000 * (2 ** Math.min(8, attempt - 1)));
  return Object.freeze({ releasedAt: now.toISOString(), retryAt: new Date(now.getTime() + delayMs).toISOString() });
}
function invalid(): never { throw new Error("Agent execution Broker operation is invalid"); }
