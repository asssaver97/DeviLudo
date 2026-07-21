import { randomUUID } from "node:crypto";
import { parseRunnerToolchainRevision } from "../../../lib/domain/runner-toolchain";
import type { TargetPlatform } from "../../../lib/domain/types";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { sha256Canonical } from "./canonical";
import { validateRunnerCapabilities, validateRunnerIdentity } from "./coordinator";
import type { RegisteredRunner, RunnerCapabilities, TlsRunnerIdentity } from "./contracts";
import type { RunnerTenantAssignmentPolicy } from "./postgres-ingress";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const GODOT_VERSION = /^4\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9]+)*$/;
const RUNNER_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TARGETS = new Set<TargetPlatform>(["windows", "linux", "macos"]);
const MAX_PUBLICATION_AGE_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 30_000;

export interface RunnerToolchainBinding {
  readonly runnerId: string;
  readonly capabilityDigest: string;
}

export interface RunnerToolchainPublication {
  readonly schemaVersion: "deviludo.runner-toolchain-publication.v1";
  readonly publicationId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requiredGodotVersion: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly runnerBindings: Readonly<Partial<Record<TargetPlatform, RunnerToolchainBinding>>>;
  readonly godotTestKitDigest: string;
  readonly buildManifestDigest: string;
  readonly sbomDigest: string;
  readonly vulnerabilityScanDigest: string;
  readonly assetLicenseLedgerDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface RunnerToolchainPublicationReceipt {
  readonly schemaVersion: "deviludo.runner-toolchain-publication-receipt.v1";
  readonly publicationId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runnerToolchainRevisionId: string;
  readonly revision: number;
  readonly runnerToolchainDigest: string;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly createdAt: string;
}

type ExistingRow = {
  request_digest: string;
  publisher_spiffe_id: string;
  runner_toolchain_revision_id: string;
  runner_toolchain_digest: string;
  revision: string | number;
  payload: unknown;
  created_at: string | Date;
};

type RunnerRow = {
  id: string;
  spiffe_id: string;
  certificate_fingerprint: string;
  certificate_serial: string;
  certificate_not_after: string | Date;
  platform: string;
  architecture: string;
  capability_digest: string;
  capabilities: unknown;
  state: string;
  registered_at: string | Date;
  last_seen_at: string | Date;
};

export class RunnerToolchainPublicationConflict extends Error {
  readonly code = "RUNNER_TOOLCHAIN_PUBLICATION_CONFLICT";
}

/**
 * Publishes only a project-scoped revision derived from currently admitted,
 * tenant-assigned physical Runner registrations. The caller can identify the
 * intended Runner and content-addressed supply-chain evidence, but it cannot
 * supply an export-template digest that differs from the registered machine.
 */
export class PostgresRunnerToolchainPublisher {
  constructor(
    private readonly pool: PostgresWorkflowPool,
    private readonly assignments: RunnerTenantAssignmentPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(
    publisher: TlsRunnerIdentity,
    input: RunnerToolchainPublication,
  ): Promise<RunnerToolchainPublicationReceipt> {
    const at = this.now();
    const publication = parseRunnerToolchainPublication(input, at);
    validateRunnerIdentity(publisher, at.toISOString());
    const requestDigest = sha256Canonical(publication);
    return this.#transaction(publication.tenantId, async (client) => {
      const project = await client.query<{ id: string }>(
        `SELECT id::text FROM deviludo.projects
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [publication.tenantId, publication.projectId],
      );
      if (project.rows.length !== 1 || project.rows[0]!.id !== publication.projectId) conflict();

      const existing = await readExisting(client, publication);
      if (existing) {
        if (existing.request_digest !== requestDigest || existing.publisher_spiffe_id !== publisher.spiffeId) conflict();
        return receiptFromRow(publication, existing);
      }

      const runnerIds = publication.targetMatrix.map((platform) => publication.runnerBindings[platform]!.runnerId);
      const selected = await client.query<RunnerRow>(
        `SELECT id, spiffe_id, certificate_fingerprint, certificate_serial,
                certificate_not_after, platform, architecture, capability_digest,
                capabilities, state, registered_at, last_seen_at
           FROM deviludo.runner_registrations
          WHERE id = ANY($1::text[])
          ORDER BY platform
          FOR SHARE`,
        [runnerIds],
      );
      if (selected.rows.length !== runnerIds.length) conflict();
      const runners = new Map<TargetPlatform, RegisteredRunner>();
      for (const row of selected.rows) {
        const runner = parseRegisteredRunner(row, at);
        const expected = publication.runnerBindings[runner.platform];
        if (!expected || expected.runnerId !== runner.runnerId
          || expected.capabilityDigest !== runner.capabilityDigest
          || runner.godotVersion !== publication.requiredGodotVersion
          || runners.has(runner.platform)
          || !(await this.assignments.authorize({
            identity: {
              spiffeId: runner.spiffeId,
              certificateFingerprint: runner.certificateFingerprint,
              certificateSerial: runner.certificateSerial,
              certificateNotAfter: runner.certificateNotAfter,
            },
            runner,
            tenantId: publication.tenantId,
          }))) conflict();
        runners.set(runner.platform, runner);
      }
      if (runners.size !== publication.targetMatrix.length) conflict();

      const payload = parseRunnerToolchainRevision(Object.freeze({
        schemaVersion: "deviludo.runner-toolchain.v1",
        requiredGodotVersion: publication.requiredGodotVersion,
        godotTestKitDigest: publication.godotTestKitDigest,
        exportTemplates: Object.freeze(Object.fromEntries(publication.targetMatrix.map((platform) => [
          platform,
          runners.get(platform)!.exportTemplatesDigest,
        ]))),
        buildManifestDigest: publication.buildManifestDigest,
        sbomDigest: publication.sbomDigest,
        vulnerabilityScanDigest: publication.vulnerabilityScanDigest,
        assetLicenseLedgerDigest: publication.assetLicenseLedgerDigest,
      }), publication.targetMatrix);
      const digest = sha256Canonical(payload);
      const revisionRow = await client.query<{ revision: string | number }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
           FROM deviludo.runner_toolchain_revisions
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid`,
        [publication.tenantId, publication.projectId],
      );
      const revision = Number(revisionRow.rows[0]?.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) conflict();
      const revisionId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO deviludo.runner_toolchain_revisions
          (id, tenant_id, project_id, revision, payload, payload_digest, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7, $8::timestamptz)`,
        [revisionId, publication.tenantId, publication.projectId, revision,
          JSON.stringify(payload), digest, publisher.spiffeId, at.toISOString()],
      );
      if (inserted.rowCount !== 1) conflict();
      const operation = await client.query(
        `INSERT INTO deviludo.runner_toolchain_publications
          (publication_id, tenant_id, project_id, request_digest,
           publisher_spiffe_id, required_godot_version, godot_testkit_digest,
           build_manifest_digest, sbom_digest, vulnerability_scan_digest,
           asset_license_ledger_digest, target_matrix, runner_bindings,
           runner_toolchain_revision_id, runner_toolchain_digest, issued_at,
           expires_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9,
                 $10, $11, $12::text[], $13::jsonb, $14::uuid, $15,
                 $16::timestamptz, $17::timestamptz, $18::timestamptz)`,
        [publication.publicationId, publication.tenantId, publication.projectId,
          requestDigest, publisher.spiffeId, publication.requiredGodotVersion,
          publication.godotTestKitDigest, publication.buildManifestDigest,
          publication.sbomDigest, publication.vulnerabilityScanDigest,
          publication.assetLicenseLedgerDigest, publication.targetMatrix,
          JSON.stringify(publication.runnerBindings), revisionId, digest,
          publication.issuedAt, publication.expiresAt, at.toISOString()],
      );
      if (operation.rowCount !== 1) conflict();
      return Object.freeze({
        schemaVersion: "deviludo.runner-toolchain-publication-receipt.v1",
        publicationId: publication.publicationId,
        tenantId: publication.tenantId,
        projectId: publication.projectId,
        runnerToolchainRevisionId: revisionId,
        revision,
        runnerToolchainDigest: digest,
        targetMatrix: publication.targetMatrix,
        createdAt: at.toISOString(),
      });
    });
  }

  async probe(): Promise<void> {
    const at = this.now();
    if (!Number.isFinite(at.getTime())) throw new Error("Runner toolchain publisher clock is invalid");
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
      try { await client.query("ROLLBACK"); } catch { /* preserve the publication failure */ }
      throw error;
    } finally { client.release(); }
  }
}

export function parseRunnerToolchainPublication(value: unknown, at: Date): RunnerToolchainPublication {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "publicationId", "tenantId", "projectId", "requiredGodotVersion",
    "targetMatrix", "runnerBindings", "godotTestKitDigest", "buildManifestDigest",
    "sbomDigest", "vulnerabilityScanDigest", "assetLicenseLedgerDigest", "issuedAt", "expiresAt",
  ]);
  if (body.schemaVersion !== "deviludo.runner-toolchain-publication.v1"
    || typeof body.publicationId !== "string" || !UUID.test(body.publicationId)
    || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
    || typeof body.projectId !== "string" || !UUID.test(body.projectId)
    || typeof body.requiredGodotVersion !== "string" || !GODOT_VERSION.test(body.requiredGodotVersion)
    || !Number.isFinite(at.getTime())) invalid();
  const targetMatrix = matrix(body.targetMatrix);
  const bindingsBody = record(body.runnerBindings);
  if (JSON.stringify(Object.keys(bindingsBody).sort()) !== JSON.stringify(targetMatrix)) invalid();
  const runnerBindings = Object.fromEntries(targetMatrix.map((platform) => {
    const binding = record(bindingsBody[platform]);
    exactKeys(binding, ["runnerId", "capabilityDigest"]);
    if (typeof binding.runnerId !== "string" || !RUNNER_ID.test(binding.runnerId)
      || typeof binding.capabilityDigest !== "string" || !SHA256.test(binding.capabilityDigest)) invalid();
    return [platform, Object.freeze({ runnerId: binding.runnerId, capabilityDigest: binding.capabilityDigest })];
  })) as Partial<Record<TargetPlatform, RunnerToolchainBinding>>;
  if (new Set(Object.values(runnerBindings).map((binding) => binding!.runnerId)).size !== targetMatrix.length) invalid();
  const issuedAt = timestamp(body.issuedAt);
  const expiresAt = timestamp(body.expiresAt);
  if (issuedAt > at.getTime() + CLOCK_SKEW_MS || expiresAt <= at.getTime()
    || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_PUBLICATION_AGE_MS) invalid();
  return deepFreeze({
    schemaVersion: "deviludo.runner-toolchain-publication.v1",
    publicationId: body.publicationId,
    tenantId: body.tenantId,
    projectId: body.projectId,
    requiredGodotVersion: body.requiredGodotVersion,
    targetMatrix,
    runnerBindings,
    godotTestKitDigest: digest(body.godotTestKitDigest),
    buildManifestDigest: digest(body.buildManifestDigest),
    sbomDigest: digest(body.sbomDigest),
    vulnerabilityScanDigest: digest(body.vulnerabilityScanDigest),
    assetLicenseLedgerDigest: digest(body.assetLicenseLedgerDigest),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

async function readExisting(
  client: PostgresWorkflowClient,
  publication: RunnerToolchainPublication,
): Promise<ExistingRow | null> {
  const selected = await client.query<ExistingRow>(
    `SELECT publication.request_digest, publication.publisher_spiffe_id,
            publication.runner_toolchain_revision_id::text,
            publication.runner_toolchain_digest, revision.revision,
            revision.payload, publication.created_at
       FROM deviludo.runner_toolchain_publications publication
       JOIN deviludo.runner_toolchain_revisions revision
         ON revision.tenant_id = publication.tenant_id
        AND revision.project_id = publication.project_id
        AND revision.id = publication.runner_toolchain_revision_id
        AND revision.payload_digest = publication.runner_toolchain_digest
      WHERE publication.tenant_id = $1::uuid
        AND publication.project_id = $2::uuid
        AND publication.publication_id = $3::uuid
      FOR SHARE OF publication, revision`,
    [publication.tenantId, publication.projectId, publication.publicationId],
  );
  if (selected.rows.length > 1) conflict();
  return selected.rows[0] ?? null;
}

function receiptFromRow(publication: RunnerToolchainPublication, row: ExistingRow): RunnerToolchainPublicationReceipt {
  const revision = Number(row.revision);
  const createdAt = new Date(row.created_at);
  const payload = parseRunnerToolchainRevision(row.payload, publication.targetMatrix);
  if (!UUID.test(row.runner_toolchain_revision_id) || !SHA256.test(row.runner_toolchain_digest)
    || sha256Canonical(payload) !== row.runner_toolchain_digest
    || payload.requiredGodotVersion !== publication.requiredGodotVersion
    || payload.godotTestKitDigest !== publication.godotTestKitDigest
    || payload.buildManifestDigest !== publication.buildManifestDigest
    || payload.sbomDigest !== publication.sbomDigest
    || payload.vulnerabilityScanDigest !== publication.vulnerabilityScanDigest
    || payload.assetLicenseLedgerDigest !== publication.assetLicenseLedgerDigest
    || !Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(createdAt.getTime())) conflict();
  return Object.freeze({
    schemaVersion: "deviludo.runner-toolchain-publication-receipt.v1",
    publicationId: publication.publicationId,
    tenantId: publication.tenantId,
    projectId: publication.projectId,
    runnerToolchainRevisionId: row.runner_toolchain_revision_id,
    revision,
    runnerToolchainDigest: row.runner_toolchain_digest,
    targetMatrix: publication.targetMatrix,
    createdAt: createdAt.toISOString(),
  });
}

function parseRegisteredRunner(row: RunnerRow, at: Date): RegisteredRunner {
  const capabilities = row.capabilities as RunnerCapabilities;
  validateRunnerCapabilities(capabilities);
  const certificateNotAfter = new Date(row.certificate_not_after);
  const registeredAt = new Date(row.registered_at);
  const lastSeenAt = new Date(row.last_seen_at);
  const identity = {
    spiffeId: row.spiffe_id,
    certificateFingerprint: row.certificate_fingerprint,
    certificateSerial: row.certificate_serial,
    certificateNotAfter: certificateNotAfter.toISOString(),
  };
  validateRunnerIdentity(identity, at.toISOString());
  if (row.state !== "ONLINE" || row.id !== capabilities.runnerId || row.platform !== capabilities.platform
    || row.architecture !== capabilities.architecture || row.capability_digest !== capabilities.capabilityDigest
    || !Number.isFinite(registeredAt.getTime()) || !Number.isFinite(lastSeenAt.getTime())) conflict();
  return deepFreeze({
    ...capabilities,
    ...identity,
    state: "ONLINE",
    registeredAt: registeredAt.toISOString(),
    lastSeenAt: lastSeenAt.toISOString(),
  });
}

function matrix(value: unknown): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => typeof item !== "string" || !TARGETS.has(item as TargetPlatform))) invalid();
  const result = [...value].sort() as TargetPlatform[];
  if (JSON.stringify(result) !== JSON.stringify(value)) invalid();
  return Object.freeze(result);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}
function timestamp(value: unknown): number {
  if (typeof value !== "string") invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  return parsed;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid();
  return value;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function invalid(): never { throw new Error("Runner toolchain publication is invalid"); }
function conflict(): never { throw new RunnerToolchainPublicationConflict("Runner toolchain publication authority conflict"); }
