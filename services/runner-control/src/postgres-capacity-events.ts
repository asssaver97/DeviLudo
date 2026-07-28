import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { MacCapacityEvent } from "./capacity-events";

type IntentRow = {
  id: string;
  operation_key: string;
  state: string;
  desired_hosts: number | string;
};

export class PostgresMacCapacityEventStore {
  readonly #pool: PostgresWorkflowPool;

  constructor(pool: PostgresWorkflowPool) { this.#pool = pool; }

  async apply(event: MacCapacityEvent, at = new Date()): Promise<void> {
    if (!Number.isFinite(at.valueOf())) throw new Error("Capacity event timestamp is invalid");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const intent = await lockIntent(client, event.intent.operationKey, event.intent.intentId);
      if (Number(intent.desired_hosts) !== event.intent.desiredHosts) conflict();
      if (event.state === "REGISTERED") await applyRegistered(client, intent, event, at);
      else if (event.state === "RELEASED") await applyReleased(client, intent, event, at);
      else await applyManualIntervention(client, intent, event, at);
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client); throw error;
    } finally { client.release(); }
  }
}

async function applyRegistered(client: PostgresWorkflowClient, intent: IntentRow, event: MacCapacityEvent, at: Date): Promise<void> {
  if (event.intent.desiredHosts !== 1 || !event.hostId || !event.instanceId || !event.runnerId
    || !event.allocatedAt || !event.minimumReleaseAt || at.valueOf() < Date.parse(event.allocatedAt)) conflict();
  let state = intent.state;
  if (state === "HOST_ALLOCATING") {
    await transitionIntent(client, intent.operation_key, "HOST_ALLOCATING", "INSTANCE_BOOTING", null, event, at);
    state = "INSTANCE_BOOTING";
  }
  if (state === "INSTANCE_BOOTING") {
    await transitionIntent(client, intent.operation_key, "INSTANCE_BOOTING", "REGISTERED", null, event, at);
    state = "REGISTERED";
  }
  if (state !== "REGISTERED") conflict();
  await client.query(
    `INSERT INTO deviludo.runner_host_leases
      (intent_id,fleet,cloud_provider,cloud_resource_ref,runner_id,state,allocated_at,registered_at,minimum_release_at)
     VALUES ($1,'MACOS','AWS',$2,$3,'REGISTERED',$4,$5,$6)
     ON CONFLICT (intent_id) DO NOTHING`,
    [intent.id, event.hostId, event.runnerId, event.allocatedAt, at.toISOString(), event.minimumReleaseAt],
  );
  const lease = await client.query<{ cloud_resource_ref: string; runner_id: string | null; state: string; minimum_release_at: string }>(
    `SELECT cloud_resource_ref,runner_id,state,minimum_release_at::text
       FROM deviludo.runner_host_leases WHERE intent_id=$1`, [intent.id],
  );
  const row = lease.rows[0];
  if (!row || row.cloud_resource_ref !== event.hostId || row.runner_id !== event.runnerId || row.state !== "REGISTERED"
    || Date.parse(row.minimum_release_at) !== Date.parse(event.minimumReleaseAt)) conflict();
}

async function applyReleased(client: PostgresWorkflowClient, intent: IntentRow, event: MacCapacityEvent, at: Date): Promise<void> {
  if (event.minimumReleaseAt && at.valueOf() < Date.parse(event.minimumReleaseAt)) conflict();
  if (event.rollback) {
    if (event.intent.desiredHosts !== 1) conflict();
    if (new Set(["HOST_ALLOCATING", "INSTANCE_BOOTING"]).has(intent.state)) {
      await transitionIntent(client, intent.operation_key, intent.state, "FAILED", "MAC_REGISTRATION_FAILED", event, at);
    } else if (intent.state !== "FAILED") conflict();
    return;
  }
  if (event.intent.desiredHosts !== 0) conflict();
  if (event.activeOperationKey) {
    const active = await lockIntent(client, event.activeOperationKey);
    if (active.state === "REGISTERED") await transitionIntent(client, active.operation_key, "REGISTERED", "DRAINING", null, event, at);
    const activeAfterDrain = active.state === "REGISTERED" ? "DRAINING" : active.state;
    if (activeAfterDrain === "DRAINING") await transitionIntent(client, active.operation_key, "DRAINING", "RELEASE_ELIGIBLE", null, event, at);
    const activeAfterEligible = activeAfterDrain === "DRAINING" ? "RELEASE_ELIGIBLE" : activeAfterDrain;
    if (activeAfterEligible === "RELEASE_ELIGIBLE") await transitionIntent(client, active.operation_key, "RELEASE_ELIGIBLE", "RELEASED", null, event, at);
    else if (activeAfterEligible !== "RELEASED") conflict();
    await releaseLease(client, active.id, at);
  }
  let state = intent.state;
  if (state === "DRAINING") {
    await transitionIntent(client, intent.operation_key, "DRAINING", "RELEASE_ELIGIBLE", null, event, at); state = "RELEASE_ELIGIBLE";
  }
  if (state === "RELEASE_ELIGIBLE") {
    await transitionIntent(client, intent.operation_key, "RELEASE_ELIGIBLE", "RELEASED", null, event, at); state = "RELEASED";
  }
  if (state !== "RELEASED") conflict();
}

async function applyManualIntervention(client: PostgresWorkflowClient, intent: IntentRow, event: MacCapacityEvent, at: Date): Promise<void> {
  if (event.intent.desiredHosts !== 0 || intent.state !== "DRAINING" || !event.activeOperationKey) conflict();
  const active = await lockIntent(client, event.activeOperationKey);
  let activeState = active.state;
  if (activeState === "REGISTERED") {
    await transitionIntent(client, active.operation_key, "REGISTERED", "DRAINING", null, event, at);
    activeState = "DRAINING";
  }
  if (activeState === "DRAINING") {
    await transitionIntent(client, active.operation_key, "DRAINING", "MANUAL_INTERVENTION_REQUIRED", "MAC_RUNNER_DRAIN_TIMEOUT", event, at);
  } else if (activeState !== "MANUAL_INTERVENTION_REQUIRED") conflict();
  const lease = await client.query<{ state: string }>(
    `SELECT state FROM deviludo.runner_host_leases WHERE intent_id=$1 FOR UPDATE`, [active.id],
  );
  if (lease.rows[0]?.state === "REGISTERED") {
    await transitionLease(client, active.id, "REGISTERED", "DRAINING", "draining_at", at);
  } else if (lease.rows[0] && lease.rows[0].state !== "DRAINING") conflict();
  await transitionIntent(client, intent.operation_key, "DRAINING", "MANUAL_INTERVENTION_REQUIRED", "MAC_RUNNER_DRAIN_TIMEOUT", event, at);
}

async function releaseLease(client: PostgresWorkflowClient, intentId: string, at: Date): Promise<void> {
  const result = await client.query<{ state: string; minimum_release_at: string }>(
    `SELECT state,minimum_release_at::text FROM deviludo.runner_host_leases WHERE intent_id=$1 FOR UPDATE`, [intentId],
  );
  let state = result.rows[0]?.state;
  if (!state) return;
  if (at.valueOf() < Date.parse(result.rows[0]!.minimum_release_at)) conflict();
  if (state === "REGISTERED") {
    await transitionLease(client, intentId, "REGISTERED", "DRAINING", "draining_at", at); state = "DRAINING";
  }
  if (state === "DRAINING") {
    await transitionLease(client, intentId, "DRAINING", "RELEASE_ELIGIBLE", null, at); state = "RELEASE_ELIGIBLE";
  }
  if (state === "RELEASE_ELIGIBLE") {
    await transitionLease(client, intentId, "RELEASE_ELIGIBLE", "RELEASED", "released_at", at); state = "RELEASED";
  }
  if (state !== "RELEASED") conflict();
}

async function transitionIntent(client: PostgresWorkflowClient, operationKey: string, from: string, to: string,
  failureCode: string | null, event: MacCapacityEvent, at: Date): Promise<void> {
  const result = await client.query(
    `UPDATE deviludo.fleet_capacity_intents
        SET state=$3,failure_code=$4,cloud_receipt=$5::jsonb,version=version+1,
            updated_at=GREATEST($6::timestamptz,updated_at + interval '1 microsecond')
      WHERE operation_key=$1 AND state=$2`,
    [operationKey, from, to, failureCode, JSON.stringify(event), at.toISOString()],
  );
  if (result.rowCount !== 1) conflict();
}

async function transitionLease(client: PostgresWorkflowClient, intentId: string, from: string, to: string,
  timestampColumn: "draining_at" | "released_at" | null, at: Date): Promise<void> {
  const assignment = timestampColumn ? `,${timestampColumn}=$4::timestamptz` : "";
  const parameters = timestampColumn ? [intentId, from, to, at.toISOString()] : [intentId, from, to];
  const result = await client.query(
    `UPDATE deviludo.runner_host_leases SET state=$3,lease_version=lease_version+1${assignment}
      WHERE intent_id=$1 AND state=$2`, parameters,
  );
  if (result.rowCount !== 1) conflict();
}

async function lockIntent(client: PostgresWorkflowClient, operationKey: string, id?: string): Promise<IntentRow> {
  const result = await client.query<IntentRow>(
    `SELECT id::text,operation_key,state,desired_hosts
       FROM deviludo.fleet_capacity_intents
      WHERE operation_key=$1 AND ($2::uuid IS NULL OR id=$2::uuid) FOR UPDATE`, [operationKey, id ?? null],
  );
  if (!result.rows[0]) conflict();
  return result.rows[0];
}

async function rollback(client: PostgresWorkflowClient): Promise<void> { try { await client.query("ROLLBACK"); } catch { /* preserve */ } }
function conflict(): never { throw new Error("AWS Mac capacity event conflicts with durable state"); }
