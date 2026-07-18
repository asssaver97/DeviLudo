import { createHash } from "node:crypto";
import type { DeliverySignal } from "../../temporal/src/contracts";
import { assertDeliverySignal } from "../../temporal/src/contracts";
import type {
  ControlPlaneWorkflowAction,
  ControlPlaneWorkflowBinding,
} from "./workflow-handler";
import type {
  ControlPlaneWorkflowSqlClient,
  ControlPlaneWorkflowSqlPool,
} from "./workflow-action-postgres";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const STEAM_AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type WorkflowActionCompletionSource =
  | "SPEC_SERVICE"
  | "USER_ACCEPTANCE_SERVICE"
  | "PROVIDER_MONITOR"
  | "MFA_BROKER"
  | "STEAM_APPROVAL_MONITOR";

export class WorkflowActionCompletionValidationError extends Error {}
export class WorkflowActionCompletionConflictError extends Error {}

export interface WorkflowActionCompletionReceipt {
  readonly actionId: string;
  readonly outboxId: string;
  readonly workflowId: string;
  readonly signalId: string;
  readonly signalDigest: string;
  readonly state: "PENDING_DELIVERY" | "DELIVERED";
  readonly replayed: boolean;
}

export interface WorkflowActionCompletionPort {
  complete(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly actionId: string;
    readonly source: WorkflowActionCompletionSource;
    readonly sourceReceiptId: string;
    readonly signal: DeliverySignal;
  }): Promise<WorkflowActionCompletionReceipt>;
}

type ActionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  operation: ControlPlaneWorkflowAction;
  status: "WAITING" | "ACKNOWLEDGED" | "COMPLETED" | "INVALIDATED";
  binding: ControlPlaneWorkflowBinding;
  completion_signal_id: string | null;
  completion_signal_digest: string | null;
  completion_source: WorkflowActionCompletionSource | null;
  completion_receipt_id: string | null;
};

type OutboxRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  action_id: string;
  signal_id: string;
  signal_digest: string;
  signal: unknown;
  state: "PENDING" | "DELIVERING" | "RETRYABLE_FAILED" | "DELIVERED";
};

type ExternalApprovalSignal = Extract<DeliverySignal, { type: "EXTERNAL_APPROVED" }>;
type ExternalApprovalAuthorityRow = {
  release_id: string;
  release_state: string;
  external_gate: string;
  build_receipt_id: string;
  build_state: string;
  steam_install_evidence_bundle_digest: string | null;
  evidence_id: string;
  evidence_bundle_digest: string;
  release_target_matrix: string[];
  attempt_target_matrix: string[];
};
type ExternalApprovalReceiptRow = {
  id: string;
  release_id: string;
  workflow_id: string;
  signal_id: string;
  gate: string;
  approval_id: string;
  verifier_subject: string;
  evidence_digest: string;
  receipt: unknown;
};

/**
 * Atomically completes one server-authoritative wait and records its exact
 * Temporal signal. Callers are internal brokers/monitors, never browsers.
 */
export class PostgresWorkflowActionCompletionStore implements WorkflowActionCompletionPort {
  constructor(private readonly pool: ControlPlaneWorkflowSqlPool) {}

  async complete(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly actionId: string;
    readonly source: WorkflowActionCompletionSource;
    readonly sourceReceiptId: string;
    readonly signal: DeliverySignal;
  }): Promise<WorkflowActionCompletionReceipt> {
    validateInput(input);
    const signalDigest = digest(input.signal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
      const actionResult = await client.query<ActionRow>(
        `SELECT id, tenant_id, project_id, workflow_id, operation, status,
                binding, completion_signal_id, completion_signal_digest,
                completion_source, completion_receipt_id
           FROM deviludo.workflow_control_actions
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.actionId],
      );
      const action = actionResult.rows[0];
      if (!action || action.project_id !== input.projectId || action.workflow_id !== input.workflowId) {
        throw new WorkflowActionCompletionConflictError("Workflow control action is unavailable in the authorized binding");
      }
      validateSignalBinding(action.operation, action.binding, input.source, input.signal);
      if (action.status === "INVALIDATED" || action.status === "ACKNOWLEDGED") {
        throw new WorkflowActionCompletionConflictError("Workflow control action cannot be completed");
      }
      if (action.status === "COMPLETED") {
        assertReplay(action, input, signalDigest);
      } else if (action.status !== "WAITING") {
        throw new WorkflowActionCompletionConflictError("Workflow control action state is invalid");
      }

      if (input.source === "STEAM_APPROVAL_MONITOR" && input.signal.type === "EXTERNAL_APPROVED") {
        await this.#recordExternalApproval(client, action, input, input.signal);
      }

      await client.query(
        `INSERT INTO deviludo.workflow_signal_outbox
          (tenant_id, project_id, workflow_id, action_id, signal_id,
           signal_digest, signal)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::jsonb)
         ON CONFLICT (tenant_id, signal_id) DO NOTHING`,
        [
          input.tenantId, input.projectId, input.workflowId, input.actionId,
          input.signal.signalId, signalDigest, JSON.stringify(input.signal),
        ],
      );
      const outboxResult = await client.query<OutboxRow>(
        `SELECT id, tenant_id, project_id, workflow_id, action_id,
                signal_id, signal_digest, signal, state
           FROM deviludo.workflow_signal_outbox
          WHERE tenant_id = $1::uuid AND signal_id = $2
          FOR UPDATE`,
        [input.tenantId, input.signal.signalId],
      );
      const outbox = outboxResult.rows[0];
      assertOutbox(outbox, input, signalDigest);
      const replayed = action.status === "COMPLETED";
      if (!replayed) {
        const updated = await client.query(
          `UPDATE deviludo.workflow_control_actions
              SET status = 'COMPLETED', completion_signal_id = $3,
                  completion_signal_digest = $4,
                  completion_source = $5, completion_receipt_id = $6,
                  completed_at = now()
            WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'WAITING'
          RETURNING id`,
          [
            input.tenantId, input.actionId, input.signal.signalId, signalDigest,
            input.source, input.sourceReceiptId,
          ],
        );
        if (updated.rows.length !== 1) {
          throw new WorkflowActionCompletionConflictError("Workflow control action completion race was lost");
        }
      }
      await client.query("COMMIT");
      return Object.freeze({
        actionId: input.actionId,
        outboxId: outbox.id,
        workflowId: input.workflowId,
        signalId: input.signal.signalId,
        signalDigest,
        state: outbox.state === "DELIVERED" ? "DELIVERED" : "PENDING_DELIVERY",
        replayed,
      });
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #recordExternalApproval(
    client: ControlPlaneWorkflowSqlClient,
    action: ActionRow,
    input: Parameters<WorkflowActionCompletionPort["complete"]>[0],
    signal: ExternalApprovalSignal,
  ): Promise<void> {
    const evidenceBundleId = action.binding.evidenceBundleId;
    const steamBuildId = action.binding.steamBuildId;
    if (!evidenceBundleId || !UUID.test(evidenceBundleId) || !steamBuildId
      || !STEAM_AUTHORITY_ID.test(signal.approvalId) || action.binding.externalGate !== signal.gate) {
      throw new WorkflowActionCompletionValidationError("External approval authority binding is invalid");
    }
    const authorityResult = await client.query<ExternalApprovalAuthorityRow>(
      `SELECT release.id::text AS release_id,
              release.state AS release_state,
              release.external_gate,
              release.target_matrix AS release_target_matrix,
              build.id::text AS build_receipt_id,
              build.state AS build_state,
              build.steam_install_evidence_bundle_digest,
              evidence.id::text AS evidence_id,
              evidence.bundle_digest AS evidence_bundle_digest,
              attempt.target_matrix AS attempt_target_matrix
         FROM deviludo.steam_build_receipts build
         JOIN deviludo.steam_releases release
           ON release.tenant_id = build.tenant_id
          AND release.project_id = build.project_id
          AND release.id = build.release_id
         JOIN deviludo.evidence_bundles evidence
           ON evidence.tenant_id = build.tenant_id
          AND evidence.project_id = build.project_id
          AND evidence.id = $5::uuid
         JOIN deviludo.e2e_attempts attempt
           ON attempt.tenant_id = evidence.tenant_id
          AND attempt.project_id = evidence.project_id
          AND attempt.id = evidence.attempt_id
        WHERE build.tenant_id = $1::uuid AND build.project_id = $2::uuid
          AND release.workflow_id = $3 AND build.build_id = $4
          AND attempt.workflow_id = $3 AND attempt.mode = 'STEAM_CLEAN_INSTALL'
          AND attempt.steam_build_id = build.build_id AND attempt.state = 'PASSED'
          AND evidence.status = 'PASSED' AND evidence.invalidated_at IS NULL
          AND build.state = 'EXTERNAL_APPROVAL_REQUIRED'
          AND build.steam_install_evidence_bundle_digest = evidence.bundle_digest
          AND release.main_commit_sha = attempt.commit_sha
          AND build.source_digest = attempt.source_digest
          AND release.run_id = attempt.run_id
        FOR UPDATE OF build, release`,
      [input.tenantId, input.projectId, input.workflowId, steamBuildId, evidenceBundleId],
    );
    if (authorityResult.rows.length !== 1) {
      throw new WorkflowActionCompletionConflictError("External approval release authority is unavailable");
    }
    const authority = authorityResult.rows[0]!;
    if (!UUID.test(authority.release_id) || !UUID.test(authority.build_receipt_id)
      || authority.evidence_id !== evidenceBundleId || !SHA256.test(authority.evidence_bundle_digest)
      || authority.steam_install_evidence_bundle_digest !== authority.evidence_bundle_digest
      || authority.build_state !== "EXTERNAL_APPROVAL_REQUIRED"
      || JSON.stringify(authority.release_target_matrix) !== JSON.stringify(authority.attempt_target_matrix)) {
      throw new WorkflowActionCompletionConflictError("External approval evidence binding conflicts with the release");
    }
    const receipt = Object.freeze({
      schemaVersion: "deviludo.external-approval.v1",
      source: input.source,
      sourceReceiptId: input.sourceReceiptId,
      actionId: input.actionId,
      workflowId: input.workflowId,
      releaseId: authority.release_id,
      buildReceiptId: authority.build_receipt_id,
      steamBuildId,
      installEvidenceBundleId: evidenceBundleId,
      installEvidenceBundleDigest: authority.evidence_bundle_digest,
      signal: Object.freeze({ ...signal }),
    });
    const evidenceDigest = digest(receipt);
    if (action.status === "WAITING") {
      if (authority.release_state !== "EXTERNAL_APPROVAL_REQUIRED" || authority.external_gate !== signal.gate) {
        throw new WorkflowActionCompletionConflictError("External approval arrived for a stale gate");
      }
      await client.query(
        `INSERT INTO deviludo.workflow_external_approval_receipts
          (tenant_id, project_id, release_id, workflow_id, signal_id, gate,
           approval_id, verifier_subject, evidence_digest, receipt, verified_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
         ON CONFLICT (release_id, gate) DO NOTHING`,
        [input.tenantId, input.projectId, authority.release_id, input.workflowId,
          signal.signalId, signal.gate, signal.approvalId, input.source, evidenceDigest, JSON.stringify(receipt)],
      );
    }
    const storedResult = await client.query<ExternalApprovalReceiptRow>(
      `SELECT id::text, release_id::text, workflow_id, signal_id, gate,
              approval_id, verifier_subject, evidence_digest, receipt
         FROM deviludo.workflow_external_approval_receipts
        WHERE tenant_id = $1::uuid AND release_id = $2::uuid AND gate = $3
        FOR SHARE`,
      [input.tenantId, authority.release_id, signal.gate],
    );
    const stored = storedResult.rows[0];
    const storedReceipt = typeof stored?.receipt === "string" ? JSON.parse(stored.receipt) as unknown : stored?.receipt;
    if (storedResult.rows.length !== 1 || !stored || !UUID.test(stored.id)
      || stored.release_id !== authority.release_id || stored.workflow_id !== input.workflowId
      || stored.signal_id !== signal.signalId || stored.gate !== signal.gate
      || stored.approval_id !== signal.approvalId || stored.verifier_subject !== input.source
      || stored.evidence_digest !== evidenceDigest || digest(storedReceipt) !== evidenceDigest) {
      throw new WorkflowActionCompletionConflictError("External approval receipt idempotency binding mismatch");
    }
    if (action.status === "COMPLETED") {
      if (!isDownstreamGate(authority.release_state, authority.external_gate, signal.gate)) {
        throw new WorkflowActionCompletionConflictError("External approval replay conflicts with release state");
      }
      return;
    }
    const next = nextGate(signal.gate);
    const updated = await client.query(
      `UPDATE deviludo.steam_releases
          SET state = $4, external_gate = $5, version = version + 1
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          AND state = 'EXTERNAL_APPROVAL_REQUIRED' AND external_gate = $6
      RETURNING id`,
      [input.tenantId, input.projectId, authority.release_id, next.state, next.gate, signal.gate],
    );
    if (updated.rows.length !== 1) {
      throw new WorkflowActionCompletionConflictError("External approval lifecycle transition was lost");
    }
  }
}

function validateInput(input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0]): void {
  for (const value of [input.tenantId, input.projectId, input.actionId]) {
    if (!UUID.test(value)) {
      throw new WorkflowActionCompletionValidationError("Workflow action completion UUID binding is invalid");
    }
  }
  if (!SAFE_ID.test(input.workflowId) || !SAFE_ID.test(input.sourceReceiptId)) {
    throw new WorkflowActionCompletionValidationError("Workflow action completion identity is invalid");
  }
  try {
    assertDeliverySignal(input.signal);
  } catch {
    throw new WorkflowActionCompletionValidationError("Workflow action completion delivery signal is invalid");
  }
}

function validateSignalBinding(
  operation: ControlPlaneWorkflowAction,
  binding: ControlPlaneWorkflowBinding,
  source: WorkflowActionCompletionSource,
  signal: DeliverySignal,
): void {
  const allowedSource: Record<Exclude<ControlPlaneWorkflowAction, "CANCEL_DELIVERY">, WorkflowActionCompletionSource> = {
    CONTINUE_IDEA_DIALOGUE: "SPEC_SERVICE",
    REQUEST_SPEC_APPROVAL: "SPEC_SERVICE",
    WAIT_FOR_PROVIDER: "PROVIDER_MONITOR",
    REQUEST_USER_ACCEPTANCE: "USER_ACCEPTANCE_SERVICE",
    REQUEST_FRESH_MFA: "MFA_BROKER",
    WAIT_FOR_EXTERNAL_APPROVAL: "STEAM_APPROVAL_MONITOR",
  };
  if (operation === "CANCEL_DELIVERY" || source !== allowedSource[operation]) invalidBinding();
  if (operation === "CONTINUE_IDEA_DIALOGUE" && signal.type === "SPEC_READY") return;
  if (operation === "REQUEST_SPEC_APPROVAL" && signal.type === "SPEC_APPROVED" && binding.specRevisionId) return;
  if (operation === "WAIT_FOR_PROVIDER" && signal.type === "PROVIDER_RESTORED"
    && signal.providerRevisionId === binding.providerRevisionId) return;
  if (operation === "REQUEST_USER_ACCEPTANCE"
    && (signal.type === "USER_ACCEPTED" || signal.type === "USER_FEEDBACK")
    && binding.candidateCommitSha && binding.evidenceBundleId) return;
  if (operation === "REQUEST_FRESH_MFA" && signal.type === "MFA_APPROVED"
    && binding.mainCommitSha && binding.evidenceBundleId) return;
  if (operation === "WAIT_FOR_EXTERNAL_APPROVAL" && signal.type === "EXTERNAL_APPROVED"
    && signal.gate === binding.externalGate && binding.steamBuildId && binding.evidenceBundleId) return;
  invalidBinding();
}

function assertReplay(
  action: ActionRow,
  input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0],
  signalDigest: string,
): void {
  if (action.completion_signal_id !== input.signal.signalId
    || action.completion_signal_digest !== signalDigest
    || action.completion_source !== input.source
    || action.completion_receipt_id !== input.sourceReceiptId) {
    throw new WorkflowActionCompletionConflictError(
      "Workflow control action completion was replayed with another authority binding",
    );
  }
}

function assertOutbox(
  outbox: OutboxRow | undefined,
  input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0],
  signalDigest: string,
): asserts outbox is OutboxRow {
  const value = typeof outbox?.signal === "string" ? JSON.parse(outbox.signal) as unknown : outbox?.signal;
  if (!outbox || !UUID.test(outbox.id) || outbox.tenant_id !== input.tenantId
    || outbox.project_id !== input.projectId || outbox.workflow_id !== input.workflowId
    || outbox.action_id !== input.actionId || outbox.signal_id !== input.signal.signalId
    || outbox.signal_digest !== signalDigest || digest(value) !== signalDigest) {
    throw new WorkflowActionCompletionConflictError("Workflow signal outbox idempotency binding mismatch");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function nextGate(gate: ExternalApprovalSignal["gate"]): Readonly<{ state: string; gate: string }> {
  if (gate === "VALVE_REVIEW") return Object.freeze({ state: "EXTERNAL_APPROVAL_REQUIRED", gate: "FIRST_RELEASE" });
  if (gate === "FIRST_RELEASE") return Object.freeze({ state: "EXTERNAL_APPROVAL_REQUIRED", gate: "DEFAULT_BRANCH_CONFIRMATION" });
  return Object.freeze({ state: "READY_TO_PUBLISH", gate: "NONE" });
}

function isDownstreamGate(state: string, gate: string, completed: ExternalApprovalSignal["gate"]): boolean {
  if (state === "READY_TO_PUBLISH" || state === "RELEASED") return gate === "NONE";
  if (state !== "EXTERNAL_APPROVAL_REQUIRED") return false;
  if (completed === "VALVE_REVIEW") return gate === "FIRST_RELEASE" || gate === "DEFAULT_BRANCH_CONFIRMATION";
  if (completed === "FIRST_RELEASE") return gate === "DEFAULT_BRANCH_CONFIRMATION";
  return false;
}

async function rollback(client: ControlPlaneWorkflowSqlClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
}

function invalidBinding(): never {
  throw new WorkflowActionCompletionValidationError("Workflow action completion signal binding is invalid");
}
