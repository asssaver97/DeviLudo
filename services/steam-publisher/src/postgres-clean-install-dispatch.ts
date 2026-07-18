import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { SteamCleanInstallDispatcher, SteamTargetPlatform } from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const SECRET_REF = /^vault:\/\/[A-Za-z0-9._~:/-]{2,500}$/;

type DispatchInput = Parameters<SteamCleanInstallDispatcher["schedule"]>[0];
type ReleaseRow = {
  id: string;
  main_commit_sha: string;
  steam_app_id: string;
  beta_branch: string | null;
  branch_password_secret_ref: string | null;
  target_matrix: string[] | null;
  state: string;
};
type ReservationRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  release_id: string;
  steam_app_id: string;
  build_id: string;
  platform: string;
  main_commit_sha: string;
  source_digest: string;
  spec_digest: string;
  test_plan_digest: string;
  reservation_digest: string;
  created_at: string;
};

/** Creates the exact per-platform handles archived in the private-Beta receipt. */
export class PostgresSteamCleanInstallDispatcher implements SteamCleanInstallDispatcher {
  readonly #now: () => Date;
  readonly #reservationId: () => string;

  constructor(
    private readonly pool: PostgresWorkflowPool,
    options: Readonly<{ now?: () => Date; reservationId?: () => string }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#reservationId = options.reservationId ?? randomUUID;
  }

  async schedule(input: DispatchInput): Promise<Readonly<Record<SteamTargetPlatform, string>>> {
    const value = validateInput(input);
    const createdAt = validNow(this.#now()).toISOString();
    return this.#transaction(value.tenantId, async (client) => {
      const releaseResult = await client.query<ReleaseRow>(
        `SELECT id::text, main_commit_sha, steam_app_id, beta_branch,
                branch_password_secret_ref, target_matrix, state
           FROM deviludo.steam_releases
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
          FOR SHARE`,
        [value.tenantId, value.projectId, value.releaseId],
      );
      const release = releaseResult.rows[0];
      if (releaseResult.rows.length !== 1 || !release || release.id !== value.releaseId
        || release.main_commit_sha !== value.mainCommitSha || release.steam_app_id !== value.steamAppId
        || release.beta_branch !== value.betaBranch || release.branch_password_secret_ref !== value.branchPasswordSecretRef
        || JSON.stringify(release.target_matrix) !== JSON.stringify(value.targetMatrix)
        || !["STEAM_PRIVATE_BETA", "INSTALL_TESTING"].includes(release.state)) invalid();

      for (const platform of value.targetMatrix) {
        const id = this.#reservationId();
        if (!UUID.test(id)) invalid();
        const reservation = reservationPayload(value, platform);
        await client.query(
          `INSERT INTO deviludo.steam_clean_install_reservations
            (id, tenant_id, project_id, release_id, steam_app_id, build_id,
             platform, main_commit_sha, source_digest, spec_digest,
             test_plan_digest, reservation_digest, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
                   $7, $8, $9, $10, $11, $12, $13::timestamptz)
           ON CONFLICT (release_id, platform) DO NOTHING`,
          [id, value.tenantId, value.projectId, value.releaseId, value.steamAppId,
            value.buildId, platform, value.mainCommitSha, value.sourceDigest,
            value.specDigest, value.testPlanDigest, sha256Canonical(reservation), createdAt],
        );
      }
      const selected = await client.query<ReservationRow>(
        `SELECT id::text, tenant_id::text, project_id::text, release_id::text,
                steam_app_id, build_id, platform, main_commit_sha, source_digest,
                spec_digest, test_plan_digest, reservation_digest, created_at::text
           FROM deviludo.steam_clean_install_reservations
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND release_id = $3::uuid
          ORDER BY platform
          FOR SHARE`,
        [value.tenantId, value.projectId, value.releaseId],
      );
      if (selected.rows.length !== value.targetMatrix.length) invalid();
      const handles: Partial<Record<SteamTargetPlatform, string>> = {};
      for (const row of selected.rows) {
        if (!isPlatform(row.platform) || !value.targetMatrix.includes(row.platform) || handles[row.platform]
          || !UUID.test(row.id) || row.tenant_id !== value.tenantId || row.project_id !== value.projectId
          || row.release_id !== value.releaseId || row.steam_app_id !== value.steamAppId
          || row.build_id !== value.buildId || row.main_commit_sha !== value.mainCommitSha
          || row.source_digest !== value.sourceDigest || row.spec_digest !== value.specDigest
          || row.test_plan_digest !== value.testPlanDigest || !Number.isFinite(Date.parse(row.created_at))
          || row.reservation_digest !== sha256Canonical(reservationPayload(value, row.platform))) invalid();
        handles[row.platform] = row.id;
      }
      if (JSON.stringify(Object.keys(handles).sort()) !== JSON.stringify(value.targetMatrix)) invalid();
      return Object.freeze(handles) as Readonly<Record<SteamTargetPlatform, string>>;
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ ready: number }>("SELECT 1 AS ready");
      if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) invalid();
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
      try { await client.query("ROLLBACK"); } catch { /* preserve dispatch error */ }
      throw error;
    } finally { client.release(); }
  }
}

function validateInput(input: DispatchInput): DispatchInput {
  if (![input.tenantId, input.projectId, input.releaseId].every((item) => UUID.test(item))
    || !NUMERIC_ID.test(input.steamAppId) || !NUMERIC_ID.test(input.buildId)
    || !BRANCH.test(input.betaBranch) || ["default", "public"].includes(input.betaBranch)
    || !SECRET_REF.test(input.branchPasswordSecretRef) || !SHA1.test(input.mainCommitSha)
    || ![input.sourceDigest, input.specDigest, input.testPlanDigest].every((item) => SHA256.test(item))) invalid();
  const targetMatrix = matrix(input.targetMatrix);
  return Object.freeze({ ...input, targetMatrix });
}

function reservationPayload(input: DispatchInput, platform: SteamTargetPlatform) {
  return Object.freeze({
    schemaVersion: "deviludo.steam-clean-install-reservation.v1",
    tenantId: input.tenantId,
    projectId: input.projectId,
    releaseId: input.releaseId,
    steamAppId: input.steamAppId,
    buildId: input.buildId,
    platform,
    mainCommitSha: input.mainCommitSha,
    sourceDigest: input.sourceDigest,
    specDigest: input.specDigest,
    testPlanDigest: input.testPlanDigest,
  });
}

function matrix(value: readonly SteamTargetPlatform[]): readonly SteamTargetPlatform[] {
  if (!value.length || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => !isPlatform(item))
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...value]);
}

function isPlatform(value: string): value is SteamTargetPlatform {
  return value === "windows" || value === "linux" || value === "macos";
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}

function invalid(): never {
  throw new Error("PostgreSQL Steam clean-install dispatch is invalid");
}
