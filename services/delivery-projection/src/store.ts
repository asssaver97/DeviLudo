import { createHash } from "node:crypto";
import {
  canonicalDeliveryJson,
  parseDeliveryProjectionRequest,
  parseDeliverySnapshot,
  type DeliveryProjectionReceipt,
  type DeliveryProjectionRequest,
} from "../../../lib/orchestration/delivery-projection";
import type { DeliverySnapshot } from "../../../lib/orchestration/game-delivery";
import {
  EVIDENCE_CATALOG_SCHEMA_VERSION,
  parseEvidenceCatalogProjection,
  type EvidenceCatalogProjection,
} from "../../../lib/evidence/catalog-projection";
import {
  RUNNER_FLEET_PROJECTION_SCHEMA_VERSION,
  parseRunnerFleetProjection,
  runnerConnectivity,
  type RunnerFleetProjection,
  type RunnerRegistrationState,
} from "../../../lib/runner/fleet-projection";
import type {
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "../../temporal/src/postgres-inbox";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export class DeliveryProjectionConflictError extends Error {}
export class DeliveryProjectionValidationError extends Error {}

export interface DeliveryProjectionView {
  readonly snapshot: DeliverySnapshot;
  readonly snapshotDigest: string;
  readonly projectedAt: string;
}

type EventRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  projection_sequence: string | number;
  projection_key: string;
  state: string;
  snapshot_digest: string;
  snapshot: unknown;
  recorded_at: string | Date;
};

type CurrentRow = Omit<EventRow, "id" | "recorded_at"> & { updated_at: string | Date };

type RunnerRow = {
  runner_id: string;
  platform: string;
  architecture: string;
  capability_digest: string;
  registration_state: RunnerRegistrationState;
  last_seen_at: string | Date;
  certificate_not_after: string | Date;
  attempt_id: string;
  lease_state: string;
  fencing_token: string | number;
  lease_expires_at: string | Date;
  updated_at: string | Date;
};

type EvidenceRow = {
  id: string;
  attempt_id: string;
  commit_sha: string;
  source_digest: string;
  binding: unknown;
  manifest: unknown;
  bundle_digest: string;
  status: string;
  invalidated_at: string | Date | null;
  created_at: string | Date;
};

export interface DeliveryProjectionStore {
  persist(input: DeliveryProjectionRequest): Promise<DeliveryProjectionReceipt>;
  read(tenantId: string, projectId: string): Promise<DeliveryProjectionView | null>;
  readRunnerFleet(tenantId: string, projectId: string): Promise<RunnerFleetProjection | null>;
  readEvidenceCatalog(tenantId: string, projectId: string): Promise<EvidenceCatalogProjection | null>;
  probe(): Promise<void>;
}

export class PostgresDeliveryProjectionStore implements DeliveryProjectionStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async persist(untrusted: DeliveryProjectionRequest): Promise<DeliveryProjectionReceipt> {
    let input: DeliveryProjectionRequest;
    try { input = parseDeliveryProjectionRequest(untrusted); }
    catch (error) { throw new DeliveryProjectionValidationError(message(error)); }
    const digest = snapshotDigest(input.snapshot);
    return this.#transaction(input.snapshot.tenantId, async (client) => {
      const authority = await client.query<{ target_matrix: string[] }>(
        `SELECT target_matrix
           FROM deviludo.spec_delivery_workflows
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
            AND workflow_id = $3`,
        [input.snapshot.tenantId, input.snapshot.projectId, input.snapshot.workflowId],
      );
      if (canonicalDeliveryJson(authority.rows[0]?.target_matrix) !== canonicalDeliveryJson(input.snapshot.targetMatrix)) conflict();
      await client.query(
        `INSERT INTO deviludo.delivery_state_projection_events
          (tenant_id, project_id, workflow_id, projection_sequence,
           projection_key, state, snapshot_digest, snapshot)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, projection_key) DO NOTHING`,
        [
          input.snapshot.tenantId,
          input.snapshot.projectId,
          input.snapshot.workflowId,
          input.snapshot.history.length,
          input.projectionKey,
          input.snapshot.state,
          digest,
          JSON.stringify(input.snapshot),
        ],
      );
      const selected = await client.query<EventRow>(
        `SELECT id, tenant_id, project_id, workflow_id, projection_sequence,
                projection_key, state, snapshot_digest, snapshot, recorded_at
           FROM deviludo.delivery_state_projection_events
          WHERE tenant_id = $1::uuid AND projection_key = $2`,
        [input.snapshot.tenantId, input.projectionKey],
      );
      const event = selected.rows[0];
      if (!event || !UUID.test(event.id) || !sameProjection(event, input, digest)) conflict();

      const currentResult = await client.query<CurrentRow>(
        `SELECT tenant_id, project_id, workflow_id, projection_sequence,
                projection_key, state, snapshot_digest, snapshot, updated_at
           FROM deviludo.delivery_state_projections
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
          FOR UPDATE`,
        [input.snapshot.tenantId, input.snapshot.projectId],
      );
      const current = currentResult.rows[0];
      const sequence = input.snapshot.history.length;
      let replayed = false;
      if (!current) {
        if (sequence !== 0 || input.snapshot.state !== "IDEATION") conflict();
        const inserted = await client.query(
          `INSERT INTO deviludo.delivery_state_projections
            (tenant_id, project_id, workflow_id, projection_sequence,
             projection_key, state, snapshot_digest, snapshot, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)`,
          [
            input.snapshot.tenantId, input.snapshot.projectId, input.snapshot.workflowId,
            sequence, input.projectionKey, input.snapshot.state, digest,
            JSON.stringify(input.snapshot), iso(event.recorded_at),
          ],
        );
        if (inserted.rowCount !== 1) conflict();
      } else {
        const currentSequence = integer(current.projection_sequence);
        if (current.workflow_id !== input.snapshot.workflowId) conflict();
        if (currentSequence >= sequence) {
          if (currentSequence === sequence && !sameProjection(current, input, digest)) conflict();
          replayed = true;
        } else {
          if (sequence !== currentSequence + 1) conflict();
          const updated = await client.query(
            `UPDATE deviludo.delivery_state_projections
                SET projection_sequence = $4, projection_key = $5,
                    state = $6, snapshot_digest = $7, snapshot = $8::jsonb,
                    updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
              WHERE tenant_id = $1::uuid AND project_id = $2::uuid
                AND workflow_id = $3 AND projection_sequence = $9
            RETURNING projection_key`,
            [
              input.snapshot.tenantId, input.snapshot.projectId, input.snapshot.workflowId,
              sequence, input.projectionKey, input.snapshot.state, digest,
              JSON.stringify(input.snapshot), currentSequence,
            ],
          );
          if (updated.rowCount !== 1) conflict();
        }
      }
      return Object.freeze({
        receiptId: event.id,
        acceptedAt: iso(event.recorded_at),
        projectionKey: input.projectionKey,
        workflowId: input.snapshot.workflowId,
        sequence,
        state: input.snapshot.state,
        snapshotDigest: digest,
        replayed,
      });
    });
  }

  async read(tenantId: string, projectId: string): Promise<DeliveryProjectionView | null> {
    validateUuid(tenantId, "Tenant");
    validateUuid(projectId, "Project");
    return this.#transaction(tenantId, async (client) => {
      const result = await client.query<CurrentRow>(
        `SELECT tenant_id, project_id, workflow_id, projection_sequence,
                projection_key, state, snapshot_digest, snapshot, updated_at
           FROM deviludo.delivery_state_projections
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid`,
        [tenantId, projectId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const snapshot = parseDeliverySnapshot(json(row.snapshot));
      const digest = snapshotDigest(snapshot);
      if (row.tenant_id !== tenantId || row.project_id !== projectId
        || row.workflow_id !== snapshot.workflowId
        || integer(row.projection_sequence) !== snapshot.history.length
        || row.projection_key !== `${snapshot.workflowId}:${snapshot.history.length}:${snapshot.state}:PROJECT_DELIVERY_SNAPSHOT`
        || row.state !== snapshot.state || row.snapshot_digest !== digest) conflict();
      return Object.freeze({ snapshot, snapshotDigest: digest, projectedAt: iso(row.updated_at) });
    });
  }

  async readRunnerFleet(tenantId: string, projectId: string): Promise<RunnerFleetProjection | null> {
    validateUuid(tenantId, "Tenant");
    validateUuid(projectId, "Project");
    return this.#transaction(tenantId, async (client) => {
      const authority = await client.query<{ project_exists: boolean; observed_at: string | Date }>(
        `SELECT EXISTS (
           SELECT 1 FROM deviludo.projects
            WHERE tenant_id = $1::uuid AND id = $2::uuid
         ) AS project_exists,
         current_timestamp AS observed_at`,
        [tenantId, projectId],
      );
      const observedAt = iso(authority.rows[0]?.observed_at ?? "");
      if (authority.rows[0]?.project_exists !== true) return null;
      const result = await client.query<RunnerRow>(
        `SELECT DISTINCT ON (lease.platform)
                registration.id AS runner_id,
                registration.platform,
                registration.architecture,
                registration.capability_digest,
                registration.state AS registration_state,
                registration.last_seen_at,
                registration.certificate_not_after,
                lease.attempt_id,
                lease.state AS lease_state,
                lease.fencing_token,
                lease.lease_expires_at,
                lease.updated_at
           FROM deviludo.e2e_platform_leases lease
           JOIN deviludo.runner_registrations registration ON registration.id = lease.runner_id
          WHERE lease.tenant_id = $1::uuid AND lease.project_id = $2::uuid
          ORDER BY lease.platform, lease.created_at DESC, lease.fencing_token DESC`,
        [tenantId, projectId],
      );
      return parseRunnerFleetProjection({
        schemaVersion: RUNNER_FLEET_PROJECTION_SCHEMA_VERSION,
        tenantId,
        projectId,
        observedAt,
        runners: result.rows.map((row) => {
          const lastSeenAt = iso(row.last_seen_at);
          const certificateNotAfter = iso(row.certificate_not_after);
          return {
            runnerId: row.runner_id,
            platform: row.platform,
            architecture: row.architecture,
            capabilityDigest: row.capability_digest,
            registrationState: row.registration_state,
            connectivity: runnerConnectivity({ registrationState: row.registration_state, lastSeenAt, certificateNotAfter }, observedAt),
            lastSeenAt,
            certificateNotAfter,
            attemptId: row.attempt_id,
            leaseState: row.lease_state,
            fencingToken: String(row.fencing_token),
            leaseExpiresAt: iso(row.lease_expires_at),
            updatedAt: iso(row.updated_at),
          };
        }),
      }, { tenantId, projectId });
    });
  }

  async readEvidenceCatalog(tenantId: string, projectId: string): Promise<EvidenceCatalogProjection | null> {
    validateUuid(tenantId, "Tenant");
    validateUuid(projectId, "Project");
    return this.#transaction(tenantId, async (client) => {
      const authority = await client.query<{ project_exists: boolean; observed_at: string | Date }>(
        `SELECT EXISTS (
           SELECT 1 FROM deviludo.projects
            WHERE tenant_id = $1::uuid AND id = $2::uuid
         ) AS project_exists,
         current_timestamp AS observed_at`,
        [tenantId, projectId],
      );
      const observedAt = iso(authority.rows[0]?.observed_at ?? "");
      if (authority.rows[0]?.project_exists !== true) return null;
      const result = await client.query<EvidenceRow>(
        `SELECT id::text, attempt_id::text, commit_sha, source_digest,
                binding, manifest, bundle_digest, status,
                invalidated_at, created_at
           FROM deviludo.evidence_bundles
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
          ORDER BY created_at DESC, id DESC
          LIMIT 50`,
        [tenantId, projectId],
      );
      let projection: EvidenceCatalogProjection;
      try {
        projection = await parseEvidenceCatalogProjection({
          schemaVersion: EVIDENCE_CATALOG_SCHEMA_VERSION,
          tenantId,
          projectId,
          observedAt,
          entries: result.rows.map((row) => ({
            evidenceBundleId: row.id,
            invalidatedAt: row.invalidated_at === null ? null : iso(row.invalidated_at),
            binding: json(row.binding),
            bundle: json(row.manifest),
          })),
        }, { tenantId, projectId });
      } catch { conflict(); }
      for (let index = 0; index < projection.entries.length; index += 1) {
        const entry = projection.entries[index]!;
        const row = result.rows[index]!;
        if (row.id !== entry.evidenceBundleId
          || row.attempt_id !== entry.bundle.attemptId
          || row.commit_sha !== entry.bundle.commitSha
          || row.source_digest !== entry.bundle.sourceDigest
          || row.bundle_digest !== entry.bundle.bundleDigest
          || row.status !== entry.bundle.status
          || iso(row.created_at) !== entry.bundle.createdAt) conflict();
      }
      return projection;
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT to_regclass('deviludo.spec_delivery_workflows')::text AS spec_delivery_workflows,
                to_regclass('deviludo.delivery_state_projection_events')::text AS delivery_state_projection_events,
                to_regclass('deviludo.delivery_state_projections')::text AS delivery_state_projections,
                to_regclass('deviludo.projects')::text AS projects,
                to_regclass('deviludo.e2e_platform_leases')::text AS e2e_platform_leases,
                to_regclass('deviludo.runner_registrations')::text AS runner_registrations,
                to_regclass('deviludo.evidence_bundles')::text AS evidence_bundles`,
      );
      const row = result.rows[0];
      for (const table of [
        "spec_delivery_workflows", "delivery_state_projection_events", "delivery_state_projections",
        "projects", "e2e_platform_leases", "runner_registrations", "evidence_bundles",
      ]) {
        if (row?.[table] !== `deviludo.${table}`) throw new Error("Delivery projection database is not ready");
      }
    } finally { client.release(); }
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

function sameProjection(
  row: Pick<EventRow, "tenant_id" | "project_id" | "workflow_id" | "projection_sequence" | "projection_key" | "state" | "snapshot_digest" | "snapshot">,
  input: DeliveryProjectionRequest,
  digest: string,
): boolean {
  return row.tenant_id === input.snapshot.tenantId
    && row.project_id === input.snapshot.projectId
    && row.workflow_id === input.snapshot.workflowId
    && integer(row.projection_sequence) === input.snapshot.history.length
    && row.projection_key === input.projectionKey
    && row.state === input.snapshot.state
    && row.snapshot_digest === digest
    && canonicalDeliveryJson(json(row.snapshot)) === canonicalDeliveryJson(input.snapshot);
}

function snapshotDigest(snapshot: DeliverySnapshot): string {
  return createHash("sha256").update(canonicalDeliveryJson(snapshot)).digest("hex");
}
function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { throw new DeliveryProjectionConflictError("Stored delivery projection is invalid"); }
}
function integer(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) conflict();
  return parsed;
}
function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) conflict();
  return date.toISOString();
}
function validateUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new DeliveryProjectionValidationError(`${name} identifier is invalid`);
}
function conflict(): never { throw new DeliveryProjectionConflictError("Delivery projection authority conflict"); }
function message(value: unknown): string { return value instanceof Error ? value.message : "Delivery projection is invalid"; }
