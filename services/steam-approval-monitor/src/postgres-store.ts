import { randomUUID } from "node:crypto";
import type { WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  parseSteamExternalApprovalAttestation,
  steamExternalApprovalRequestDigest,
  validSteamApprovalVerifierSubject,
  type SteamExternalApprovalAttestation,
  type SteamExternalApprovalReceipt,
} from "./contracts";
import {
  SteamExternalApprovalConflict,
  type SteamExternalApprovalClaim,
  type SteamExternalApprovalStore,
} from "./service";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNAL_ID = /^steam-approval-[a-f0-9-]{36}$/;

type ObservationRow = {
  operation_key: string;
  request_digest: string;
  tenant_id: string;
  project_id: string;
  action_id: string;
  workflow_id: string;
  verifier_subject: string;
  gate: string;
  observation_kind: string;
  steam_app_id: string;
  steam_build_id: string;
  approval_id: string;
  observation_digest: string;
  observed_at: string;
  signal_id: string;
  state: "PENDING" | "COMPLETED";
  claim_token: string | null;
  claim_active: boolean;
  receipt: unknown | null;
};

type AuthorityRow = {
  action_id: string;
  workflow_id: string;
  action_operation: string;
  action_status: string;
  action_binding: unknown;
  release_id: string;
  release_state: string;
  release_gate: string;
  release_app_id: string;
  release_target_matrix: string[];
  build_receipt_id: string;
  build_state: string;
  build_app_id: string;
  build_id: string;
  install_evidence_digest: string | null;
  evidence_id: string;
  evidence_digest: string;
  evidence_status: string;
  evidence_invalidated_at: string | null;
  attempt_state: string;
  attempt_mode: string;
  attempt_workflow_id: string;
  attempt_target_matrix: string[];
};

/** Durable, tenant-RLS ingress ledger for an independently observed Steam gate. */
export class PostgresSteamExternalApprovalStore implements SteamExternalApprovalStore {
  readonly #now: () => Date;
  readonly #claimId: () => string;
  readonly #signalId: () => string;
  readonly #maxObservationAgeMs: number;
  readonly #maxFutureSkewMs: number;

  constructor(
    private readonly pool: PostgresWorkflowPool,
    options: Readonly<{
      now?: () => Date;
      claimId?: () => string;
      signalId?: () => string;
      maxObservationAgeMs?: number;
      maxFutureSkewMs?: number;
    }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#claimId = options.claimId ?? randomUUID;
    this.#signalId = options.signalId ?? (() => `steam-approval-${randomUUID()}`);
    this.#maxObservationAgeMs = boundedDuration(options.maxObservationAgeMs ?? 15 * 60_000, 60_000, 60 * 60_000);
    this.#maxFutureSkewMs = boundedDuration(options.maxFutureSkewMs ?? 60_000, 0, 5 * 60_000);
  }

  async begin(input: { readonly attestation: SteamExternalApprovalAttestation; readonly verifierSubject: string }) {
    const attestation = parseSteamExternalApprovalAttestation(input.attestation);
    if (!validSteamApprovalVerifierSubject(input.verifierSubject)) invalid();
    const requestDigest = steamExternalApprovalRequestDigest(attestation);
    const now = exactDate(this.#now());
    const claimToken = this.#claimId();
    const signalId = this.#signalId();
    if (!UUID.test(claimToken) || !SIGNAL_ID.test(signalId)) invalid();
    return this.#transaction(attestation.tenantId, async (client) => {
      const existing = await selectObservation(client, attestation.tenantId, attestation.operationKey, attestation.actionId);
      if (existing) return existingOutcome(existing, attestation, input.verifierSubject, requestDigest, claimToken, now, client);

      assertFreshObservation(attestation, now, this.#maxObservationAgeMs, this.#maxFutureSkewMs);
      const authority = await selectAuthority(client, attestation);
      assertAuthority(authority, attestation);
      await client.query(
        `INSERT INTO deviludo.steam_external_approval_observations
          (operation_key, request_digest, tenant_id, project_id, action_id, workflow_id,
           verifier_subject, gate, observation_kind, steam_app_id, steam_build_id,
           approval_id, observation_digest, observed_at, signal_id,
           state, claim_token, claim_expires_at)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6,
                 $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15,
                 'PENDING', $16::uuid, $17::timestamptz)
         ON CONFLICT DO NOTHING`,
        [attestation.operationKey, requestDigest, attestation.tenantId, attestation.projectId,
          attestation.actionId, authority.workflow_id, input.verifierSubject, attestation.gate,
          attestation.observationKind, attestation.steamAppId, attestation.steamBuildId,
          attestation.approvalId, attestation.observationDigest, attestation.observedAt,
          signalId, claimToken, new Date(now.getTime() + 2 * 60_000).toISOString()],
      );
      const selected = await selectObservation(client, attestation.tenantId, attestation.operationKey, attestation.actionId);
      if (!selected) conflict();
      assertObservationBinding(selected, attestation, input.verifierSubject, requestDigest);
      if (selected.claim_token !== claimToken || selected.signal_id !== signalId || selected.state !== "PENDING") {
        return selected.receipt !== null
          ? { kind: "COMPLETED" as const, receipt: parseReceipt(selected.receipt, selected) }
          : { kind: "BUSY" as const };
      }
      return { kind: "CLAIMED" as const, claim: claimFrom(selected, claimToken) };
    });
  }

  async complete(claim: SteamExternalApprovalClaim, delivery: WorkflowActionCompletionReceipt): Promise<SteamExternalApprovalReceipt> {
    validateClaim(claim);
    validateDelivery(delivery, claim);
    const receipt = Object.freeze({
      schemaVersion: "deviludo.steam-external-approval-receipt.v1" as const,
      operationKey: claim.attestation.operationKey,
      actionId: claim.attestation.actionId,
      workflowId: claim.workflowId,
      gate: claim.attestation.gate,
      approvalId: claim.attestation.approvalId,
      observationDigest: claim.attestation.observationDigest,
      observedAt: claim.attestation.observedAt,
      verifierSubject: claim.verifierSubject,
      delivery: Object.freeze({ ...delivery }),
      replayed: delivery.replayed,
    });
    return this.#transaction(claim.attestation.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.steam_external_approval_observations
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                completion_outbox_id = $5::uuid, receipt = $6::jsonb,
                completed_at = now(), updated_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND request_digest = $3 AND claim_token = $4::uuid
            AND state = 'PENDING' AND receipt IS NULL
        RETURNING operation_key`,
        [claim.attestation.tenantId, claim.attestation.operationKey,
          claim.requestDigest, claim.claimToken, delivery.outboxId, JSON.stringify(receipt)],
      );
      if (updated.rowCount !== 1) conflict();
      return receipt;
    });
  }

  async release(claim: SteamExternalApprovalClaim): Promise<void> {
    validateClaim(claim);
    await this.#transaction(claim.attestation.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.steam_external_approval_observations
            SET claim_token = NULL, claim_expires_at = NULL, updated_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND request_digest = $3 AND claim_token = $4::uuid
            AND state = 'PENDING' AND receipt IS NULL`,
        [claim.attestation.tenantId, claim.attestation.operationKey, claim.requestDigest, claim.claimToken],
      );
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("SELECT 1 AS steam_external_approval_store_probe"); }
    finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

async function selectObservation(client: PostgresWorkflowClient, tenantId: string, operationKey: string, actionId: string) {
  const selected = await client.query<ObservationRow>(
    `SELECT operation_key, request_digest, tenant_id::text, project_id::text,
            action_id::text, workflow_id, verifier_subject, gate, observation_kind,
            steam_app_id, steam_build_id, approval_id, observation_digest,
            observed_at::text, signal_id, state, claim_token::text,
            COALESCE(claim_expires_at > now(), false) AS claim_active, receipt
       FROM deviludo.steam_external_approval_observations
      WHERE tenant_id = $1::uuid AND (operation_key = $2 OR action_id = $3::uuid)
      FOR UPDATE`,
    [tenantId, operationKey, actionId],
  );
  if (selected.rows.length > 1) conflict();
  return selected.rows[0] ?? null;
}

async function selectAuthority(client: PostgresWorkflowClient, input: SteamExternalApprovalAttestation): Promise<AuthorityRow> {
  const selected = await client.query<AuthorityRow>(
    `SELECT action.id::text AS action_id, action.workflow_id,
            action.operation AS action_operation, action.status AS action_status,
            action.binding AS action_binding,
            release.id::text AS release_id, release.state AS release_state,
            release.external_gate AS release_gate, release.steam_app_id AS release_app_id,
            release.target_matrix AS release_target_matrix,
            build.id::text AS build_receipt_id, build.state AS build_state,
            build.steam_app_id AS build_app_id, build.build_id,
            build.steam_install_evidence_bundle_digest AS install_evidence_digest,
            evidence.id::text AS evidence_id, evidence.bundle_digest AS evidence_digest,
            evidence.status AS evidence_status, evidence.invalidated_at::text AS evidence_invalidated_at,
            attempt.state AS attempt_state, attempt.mode AS attempt_mode,
            attempt.workflow_id AS attempt_workflow_id, attempt.target_matrix AS attempt_target_matrix
       FROM deviludo.workflow_control_actions action
       JOIN deviludo.steam_releases release
         ON release.tenant_id = action.tenant_id
        AND release.project_id = action.project_id
        AND release.workflow_id = action.workflow_id
       JOIN deviludo.steam_build_receipts build
         ON build.tenant_id = release.tenant_id
        AND build.project_id = release.project_id
        AND build.release_id = release.id
       JOIN deviludo.evidence_bundles evidence
         ON evidence.tenant_id = action.tenant_id
        AND evidence.project_id = action.project_id
        AND evidence.id::text = action.binding->>'evidenceBundleId'
       JOIN deviludo.e2e_attempts attempt
         ON attempt.tenant_id = evidence.tenant_id
        AND attempt.project_id = evidence.project_id
        AND attempt.id = evidence.attempt_id
      WHERE action.tenant_id = $1::uuid AND action.project_id = $2::uuid
        AND action.id = $3::uuid
      FOR UPDATE OF action, release, build`,
    [input.tenantId, input.projectId, input.actionId],
  );
  if (selected.rows.length !== 1) conflict();
  return selected.rows[0]!;
}

function assertAuthority(row: AuthorityRow, input: SteamExternalApprovalAttestation): void {
  const binding = record(row.action_binding);
  if (row.action_id !== input.actionId || !UUID.test(row.release_id) || !UUID.test(row.build_receipt_id)
    || row.action_operation !== "WAIT_FOR_EXTERNAL_APPROVAL" || row.action_status !== "WAITING"
    || binding.state !== "EXTERNAL_APPROVAL_REQUIRED" || binding.externalGate !== input.gate
    || binding.steamBuildId !== input.steamBuildId || binding.evidenceBundleId !== row.evidence_id
    || row.release_state !== "EXTERNAL_APPROVAL_REQUIRED" || row.release_gate !== input.gate
    || row.release_app_id !== input.steamAppId || row.build_app_id !== input.steamAppId
    || row.build_id !== input.steamBuildId || row.build_state !== "EXTERNAL_APPROVAL_REQUIRED"
    || row.evidence_status !== "PASSED" || row.evidence_invalidated_at !== null
    || row.install_evidence_digest !== row.evidence_digest || !SHA256.test(row.evidence_digest)
    || row.attempt_state !== "PASSED" || row.attempt_mode !== "STEAM_CLEAN_INSTALL"
    || row.attempt_workflow_id !== row.workflow_id
    || JSON.stringify(row.release_target_matrix) !== JSON.stringify(row.attempt_target_matrix)) conflict();
}

async function existingOutcome(
  row: ObservationRow,
  attestation: SteamExternalApprovalAttestation,
  verifierSubject: string,
  requestDigest: string,
  claimToken: string,
  now: Date,
  client: PostgresWorkflowClient,
) {
  assertObservationBinding(row, attestation, verifierSubject, requestDigest);
  if (row.state === "COMPLETED") return { kind: "COMPLETED" as const, receipt: parseReceipt(row.receipt, row) };
  if (row.receipt !== null) conflict();
  if (row.claim_token && row.claim_active) return { kind: "BUSY" as const };
  const reclaimed = await client.query(
    `UPDATE deviludo.steam_external_approval_observations
        SET claim_token = $4::uuid, claim_expires_at = $5::timestamptz, updated_at = now()
      WHERE tenant_id = $1::uuid AND operation_key = $2 AND request_digest = $3
        AND state = 'PENDING' AND receipt IS NULL
        AND (claim_token IS NULL OR claim_expires_at <= now())
    RETURNING operation_key`,
    [attestation.tenantId, attestation.operationKey, requestDigest, claimToken,
      new Date(now.getTime() + 2 * 60_000).toISOString()],
  );
  if (reclaimed.rowCount !== 1) return { kind: "BUSY" as const };
  return { kind: "CLAIMED" as const, claim: claimFrom(row, claimToken) };
}

function claimFrom(row: ObservationRow, claimToken: string): SteamExternalApprovalClaim {
  return Object.freeze({
    claimToken,
    requestDigest: row.request_digest,
    verifierSubject: row.verifier_subject,
    attestation: parseSteamExternalApprovalAttestation({
      schemaVersion: "deviludo.steam-external-approval.v1",
      operationKey: row.operation_key,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      actionId: row.action_id,
      gate: row.gate,
      observationKind: row.observation_kind,
      steamAppId: row.steam_app_id,
      steamBuildId: row.steam_build_id,
      approvalId: row.approval_id,
      observationDigest: row.observation_digest,
      observedAt: row.observed_at,
    }),
    workflowId: row.workflow_id,
    signalId: row.signal_id,
  });
}

function assertObservationBinding(row: ObservationRow, input: SteamExternalApprovalAttestation, verifier: string, digest: string): void {
  if (row.operation_key !== input.operationKey || row.request_digest !== digest
    || row.tenant_id !== input.tenantId || row.project_id !== input.projectId
    || row.action_id !== input.actionId || row.verifier_subject !== verifier
    || row.gate !== input.gate || row.observation_kind !== input.observationKind
    || row.steam_app_id !== input.steamAppId || row.steam_build_id !== input.steamBuildId
    || row.approval_id !== input.approvalId || row.observation_digest !== input.observationDigest
    || new Date(row.observed_at).toISOString() !== input.observedAt || !SIGNAL_ID.test(row.signal_id)) conflict();
}

function parseReceipt(value: unknown, row: ObservationRow): SteamExternalApprovalReceipt {
  const candidate = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) conflict();
  const receipt = candidate as SteamExternalApprovalReceipt;
  if (receipt.schemaVersion !== "deviludo.steam-external-approval-receipt.v1"
    || receipt.operationKey !== row.operation_key || receipt.actionId !== row.action_id
    || receipt.workflowId !== row.workflow_id || receipt.gate !== row.gate
    || receipt.approvalId !== row.approval_id || receipt.observationDigest !== row.observation_digest
    || receipt.observedAt !== new Date(row.observed_at).toISOString()
    || receipt.verifierSubject !== row.verifier_subject || typeof receipt.replayed !== "boolean" || !receipt.delivery
    || receipt.delivery.actionId !== row.action_id || receipt.delivery.workflowId !== row.workflow_id
    || receipt.delivery.signalId !== row.signal_id || !SHA256.test(receipt.delivery.signalDigest)) conflict();
  return Object.freeze({ ...receipt, delivery: Object.freeze({ ...receipt.delivery }) });
}

function validateClaim(claim: SteamExternalApprovalClaim): void {
  if (!UUID.test(claim.claimToken) || !SHA256.test(claim.requestDigest)
    || !validSteamApprovalVerifierSubject(claim.verifierSubject) || !SIGNAL_ID.test(claim.signalId)
    || steamExternalApprovalRequestDigest(parseSteamExternalApprovalAttestation(claim.attestation)) !== claim.requestDigest) invalid();
}
function validateDelivery(value: WorkflowActionCompletionReceipt, claim: SteamExternalApprovalClaim): void {
  if (value.actionId !== claim.attestation.actionId || value.workflowId !== claim.workflowId
    || value.signalId !== claim.signalId || !UUID.test(value.outboxId) || !SHA256.test(value.signalDigest)
    || (value.state !== "PENDING_DELIVERY" && value.state !== "DELIVERED")) conflict();
}
function assertFreshObservation(value: SteamExternalApprovalAttestation, now: Date, maximumAge: number, futureSkew: number): void {
  const observed = Date.parse(value.observedAt);
  if (observed < now.getTime() - maximumAge || observed > now.getTime() + futureSkew) invalid();
}
function exactDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) invalid();
  return value;
}
function boundedDuration(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) conflict();
  return value as Record<string, unknown>;
}
function invalid(): never { throw new Error("Steam external approval store binding is invalid"); }
function conflict(): never { throw new SteamExternalApprovalConflict("STEAM_EXTERNAL_APPROVAL_CONFLICT"); }
