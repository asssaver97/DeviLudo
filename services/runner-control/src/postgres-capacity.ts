import type { Fleet, FleetCapacityDecision, FleetDemand } from "../../../lib/runtime/fleet-capacity";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { FleetCapacityIntent, FleetCapacityStore } from "./capacity-controller";

type AggregateRow = {
  queued_agent: string | number;
  running_agent: string | number;
  queued_linux: string | number;
  queued_windows: string | number;
  queued_macos: string | number;
  running_linux: string | number;
  running_windows: string | number;
  running_macos: string | number;
  online_linux: string | number;
  online_windows: string | number;
  online_macos: string | number;
  gpu_linux: string | number;
  gpu_windows: string | number;
  mac_release_eligible: boolean;
};

export class PostgresFleetCapacityStore implements FleetCapacityStore {
  readonly #pool: PostgresWorkflowPool;

  constructor(pool: PostgresWorkflowPool) { this.#pool = pool; }

  async probe(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query<{ intents: string | null; leases: string | null }>(
        `SELECT to_regclass('deviludo.fleet_capacity_intents')::text AS intents,
                to_regclass('deviludo.runner_host_leases')::text AS leases`,
      );
      if (result.rows[0]?.intents !== "deviludo.fleet_capacity_intents"
        || result.rows[0]?.leases !== "deviludo.runner_host_leases") {
        throw new Error("Fleet capacity database is not ready");
      }
    } finally { client.release(); }
  }

  async loadP0Health(at: Date): Promise<Readonly<{ linuxOnline: number; windowsOnline: number; migrationCount: number; migrationHead: number }>> {
    if (!Number.isFinite(at.valueOf())) throw new Error("Fleet health timestamp is invalid");
    const client = await this.#pool.connect();
    try {
      const result = await client.query<{
        linux_online: string | number; windows_online: string | number; migration_count: string | number; migration_head: string | number;
      }>(
        `SELECT
          (SELECT count(*) FROM deviludo.runner_registrations
            WHERE platform='linux' AND state='ONLINE' AND certificate_not_after>$1 AND last_seen_at>$1::timestamptz-interval '2 minutes') linux_online,
          (SELECT count(*) FROM deviludo.runner_registrations
            WHERE platform='windows' AND state='ONLINE' AND certificate_not_after>$1 AND last_seen_at>$1::timestamptz-interval '2 minutes') windows_online,
          (SELECT count(*) FROM public.deviludo_schema_migrations) migration_count,
          (SELECT COALESCE(max(version),0) FROM public.deviludo_schema_migrations) migration_head`,
        [at.toISOString()],
      );
      const row = result.rows[0];
      if (!row) throw new Error("P0 health query returned no row");
      return Object.freeze({ linuxOnline: integer(row.linux_online), windowsOnline: integer(row.windows_online),
        migrationCount: integer(row.migration_count), migrationHead: integer(row.migration_head) });
    } finally { client.release(); }
  }

  async loadDemand(at: Date): Promise<FleetDemand> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query<AggregateRow>(
        `SELECT
          (SELECT count(*) FROM deviludo.agent_execution_operations WHERE state IN ('QUEUED','WAITING_PROVIDER')) queued_agent,
          (SELECT count(*) FROM deviludo.agent_execution_operations WHERE state IN ('PREPARING','RUNNING')) running_agent,
          count(*) FILTER (WHERE a.state='QUEUED' AND 'linux'=ANY(a.target_matrix)) queued_linux,
          count(*) FILTER (WHERE a.state='QUEUED' AND 'windows'=ANY(a.target_matrix)) queued_windows,
          count(*) FILTER (WHERE a.state='QUEUED' AND 'macos'=ANY(a.target_matrix)) queued_macos,
          count(*) FILTER (WHERE a.state='RUNNING' AND 'linux'=ANY(a.target_matrix)) running_linux,
          count(*) FILTER (WHERE a.state='RUNNING' AND 'windows'=ANY(a.target_matrix)) running_windows,
          count(*) FILTER (WHERE a.state='RUNNING' AND 'macos'=ANY(a.target_matrix)) running_macos,
          (SELECT count(*) FROM deviludo.runner_registrations WHERE state='ONLINE' AND platform='linux') online_linux,
          (SELECT count(*) FROM deviludo.runner_registrations WHERE state='ONLINE' AND platform='windows') online_windows,
          (SELECT count(*) FROM deviludo.runner_registrations WHERE state='ONLINE' AND platform='macos') online_macos,
          count(*) FILTER (WHERE a.state='QUEUED' AND a.runner_workload_class='GPU' AND 'linux'=ANY(a.target_matrix)) gpu_linux,
          count(*) FILTER (WHERE a.state='QUEUED' AND a.runner_workload_class='GPU' AND 'windows'=ANY(a.target_matrix)) gpu_windows,
          COALESCE((SELECT bool_and($1::timestamptz >= minimum_release_at)
             FROM deviludo.runner_host_leases
            WHERE fleet='MACOS' AND state NOT IN ('RELEASED','FAILED')), true) mac_release_eligible
         FROM deviludo.e2e_attempts a`,
        [at.toISOString()],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Fleet demand query returned no row");
      return Object.freeze({
        queued: Object.freeze({ AGENT: integer(row.queued_agent), LINUX: integer(row.queued_linux), WINDOWS: integer(row.queued_windows), MACOS: integer(row.queued_macos) }),
        running: Object.freeze({ AGENT: integer(row.running_agent), LINUX: integer(row.running_linux), WINDOWS: integer(row.running_windows), MACOS: integer(row.running_macos) }),
        onlineHosts: Object.freeze({ AGENT: 1, LINUX: integer(row.online_linux), WINDOWS: integer(row.online_windows), MACOS: integer(row.online_macos) }),
        gpuQueued: Object.freeze({ linux: integer(row.gpu_linux), windows: integer(row.gpu_windows) }),
        macReleaseEligible: row.mac_release_eligible === true,
      });
    } finally { client.release(); }
  }

  async latestDesiredHosts(): Promise<Readonly<Record<Fleet, number | null>>> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query<{ fleet: Fleet; desired_hosts: string | number }>(
        `SELECT DISTINCT ON (fleet) fleet,desired_hosts
           FROM deviludo.fleet_capacity_intents
          ORDER BY fleet,requested_at DESC,id DESC`,
      );
      const values: Record<Fleet, number | null> = { AGENT: null, LINUX: null, WINDOWS: null, MACOS: null };
      for (const row of result.rows) values[row.fleet] = integer(row.desired_hosts);
      return Object.freeze(values);
    } finally { client.release(); }
  }

  async createIntent(decision: FleetCapacityDecision, at: Date): Promise<FleetCapacityIntent> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      let result = await client.query<{
        id: string; state: "REQUESTED" | "HOST_ALLOCATING" | "DRAINING"; requested_at: string;
      }>(
        `INSERT INTO deviludo.fleet_capacity_intents
          (fleet,desired_hosts,reason,operation_key,state,requested_at,minimum_release_at,updated_at)
         VALUES ($1,$2,$3,$4,'REQUESTED',$5,$6,$5)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING id,state,requested_at`,
        [decision.fleet, decision.desiredHosts, decision.reason, decision.operationKey, at.toISOString(), decision.minimumReleaseAt],
      );
      if (!result.rows[0]) {
        result = await client.query(
          `SELECT id,state,requested_at
             FROM deviludo.fleet_capacity_intents
            WHERE operation_key=$1 AND fleet=$2 AND desired_hosts=$3 AND reason=$4`,
          [decision.operationKey, decision.fleet, decision.desiredHosts, decision.reason],
        );
      }
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) throw new Error("Fleet intent was not persisted");
      return Object.freeze({ ...decision, id: row.id, state: row.state, requestedAt: new Date(row.requested_at).toISOString() });
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  async markPublished(intent: FleetCapacityIntent, receipt: Readonly<Record<string, unknown>>, at: Date): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        `UPDATE deviludo.fleet_capacity_intents
            SET state=$2,cloud_receipt=$3::jsonb,version=version+1,updated_at=$4
          WHERE id=$1 AND state='REQUESTED' AND version=1`,
        [intent.id, intent.desiredHosts === 0 ? "DRAINING" : "HOST_ALLOCATING", JSON.stringify(receipt), at.toISOString()],
      );
      if (result.rowCount !== 1) throw new Error("Fleet intent publication raced with another controller");
    } finally { client.release(); }
  }
}

async function rollback(client: PostgresWorkflowClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
}

function integer(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Fleet aggregate is invalid");
  return parsed;
}
