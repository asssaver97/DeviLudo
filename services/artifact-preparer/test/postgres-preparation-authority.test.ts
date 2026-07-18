import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type {
  PostgresQueryResult,
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "../../temporal/src/postgres-inbox";
import { PostgresSourceExecutionPreparationAuthority } from "../src/postgres-preparation-authority";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const specRevisionId = "44444444-4444-4444-8444-444444444444";
const runnerToolchainRevisionId = "55555555-5555-4555-8555-555555555555";
const sha = (value: string) => value.repeat(64);
const commitSha = "a".repeat(40);
const sourceDigest = sha("b");
const testPlanDigest = sha("c");
const specPayload = { schemaVersion: "deviludo.game-spec.v1", title: "Authority fixture" };
const specDigest = sha256Canonical(specPayload);
const toolchainPayload = {
  schemaVersion: "deviludo.runner-toolchain.v1",
  requiredGodotVersion: "4.6.2-stable",
  godotTestKitDigest: sha("d"),
  exportTemplates: { linux: sha("e") },
  buildManifestDigest: sha("f"),
  sbomDigest: sha("0"),
  vulnerabilityScanDigest: sha("1"),
  assetLicenseLedgerDigest: sha("2"),
};
const runnerToolchainDigest = sha256Canonical(toolchainPayload);

function trigger(mode: "CANDIDATE" | "MAIN_RELEASE_GATE" = "CANDIDATE") {
  return {
    schemaVersion: "deviludo.source-execution-preparation-trigger.v1",
    tenantId,
    projectId,
    runId,
    lockKey: sha("3"),
    mode,
    commitSha,
    targetMatrix: ["linux"],
  };
}

class ScriptedClient implements PostgresWorkflowClient {
  readonly sql: string[] = [];
  released = 0;
  constructor(
    readonly mode: "CANDIDATE" | "MAIN_RELEASE_GATE" = "CANDIDATE",
    readonly drift: "none" | "toolchain" | "source" = "none",
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.sql.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result([]);
    if (text.includes("set_config('app.tenant_id'")) {
      assert.deepEqual(values, [tenantId]);
      return result([]);
    }
    if (text.includes("FROM deviludo.agent_runs run")) {
      assert.deepEqual(values, [tenantId, projectId, runId]);
      const digest = this.drift === "toolchain" ? sha("9") : runnerToolchainDigest;
      return result([{
        run_id: runId,
        configuration_lock: {
          specRevisionId,
          specDigest,
          testPlanDigest,
          runnerToolchainRevisionId,
          runnerToolchainDigest,
          targetMatrix: ["linux"],
        },
        spec_revision_id: specRevisionId,
        spec_payload: specPayload,
        spec_digest: specDigest,
        test_plan_digest: testPlanDigest,
        target_matrix: ["linux"],
        required_godot_version: "4.6.2-stable",
        runner_toolchain_revision_id: runnerToolchainRevisionId,
        runner_toolchain_digest: digest,
        toolchain_payload: toolchainPayload,
        toolchain_payload_digest: digest,
      }] as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.github_candidate_receipts")) {
      assert.equal(this.mode, "CANDIDATE");
      assert.deepEqual(values, [tenantId, projectId, runId, commitSha]);
      return result((this.drift === "source" ? [] : [{ source_digest: sourceDigest }]) as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.github_merge_receipts merge")) {
      assert.equal(this.mode, "MAIN_RELEASE_GATE");
      assert.deepEqual(values, [tenantId, projectId, runId, commitSha]);
      return result([{ source_digest: sourceDigest }] as unknown as Row[]);
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void { this.released += 1; }
}

function pool(client: ScriptedClient): PostgresWorkflowPool {
  return { async connect() { return client; } };
}

function result<Row extends Record<string, unknown>>(rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount: rows.length, rows };
}

for (const mode of ["CANDIDATE", "MAIN_RELEASE_GATE"] as const) {
  test(`PostgreSQL preparation authority resolves ${mode} only from immutable tenant rows`, async () => {
    const client = new ScriptedClient(mode);
    const authority = new PostgresSourceExecutionPreparationAuthority(pool(client));
    const resolved = await authority.resolve(trigger(mode));
    assert.equal(resolved.sourceDigest, sourceDigest);
    assert.equal(resolved.specDigest, specDigest);
    assert.equal(resolved.runnerToolchainRevisionId, runnerToolchainRevisionId);
    assert.equal(resolved.runnerToolchainDigest, runnerToolchainDigest);
    assert.deepEqual(resolved.toolchain, toolchainPayload);
    assert.ok(client.sql.some((sql) => sql.includes("FOR SHARE OF run, spec, binding, toolchain")));
    assert.ok(client.sql.some((sql) => sql.includes("set_config('app.tenant_id'")));
    assert.ok(client.sql.includes("COMMIT"));
    assert.equal(client.released, 1);
  });
}

test("PostgreSQL preparation authority rejects toolchain drift before reading source", async () => {
  const client = new ScriptedClient("CANDIDATE", "toolchain");
  const authority = new PostgresSourceExecutionPreparationAuthority(pool(client));
  await assert.rejects(authority.resolve(trigger()), /authority receipt is invalid/);
  assert.ok(client.sql.includes("ROLLBACK"));
  assert.ok(!client.sql.some((sql) => sql.includes("FROM deviludo.github_candidate_receipts")));
});

test("PostgreSQL preparation authority fails closed when the authoritative source receipt is absent", async () => {
  const client = new ScriptedClient("CANDIDATE", "source");
  const authority = new PostgresSourceExecutionPreparationAuthority(pool(client));
  await assert.rejects(authority.resolve(trigger()), /authority receipt is invalid/);
  assert.ok(client.sql.includes("ROLLBACK"));
});

test("preparation trigger rejects caller-supplied executable configuration", async () => {
  const client = new ScriptedClient();
  const authority = new PostgresSourceExecutionPreparationAuthority(pool(client));
  await assert.rejects(authority.resolve({ ...trigger(), sourceDigest }), /trigger fields is invalid/);
  assert.equal(client.sql.length, 0);
});
