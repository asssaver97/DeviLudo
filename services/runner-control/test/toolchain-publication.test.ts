import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { RunnerCapabilities, TlsRunnerIdentity } from "../src/contracts";
import { createRunnerCapabilityDigest } from "../src/coordinator";
import type { RunnerTenantAssignmentPolicy } from "../src/postgres-ingress";
import {
  parseRunnerToolchainPublication,
  PostgresRunnerToolchainPublisher,
  RunnerToolchainPublicationConflict,
  type RunnerToolchainPublication,
} from "../src/toolchain-publication";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const publicationId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2030-01-01T00:05:00.000Z");
const sha = (value: string) => value.repeat(64);

const publisherIdentity: TlsRunnerIdentity = Object.freeze({
  spiffeId: "spiffe://deviludo.test/supply-chain/runner-toolchain",
  certificateFingerprint: sha("a"),
  certificateSerial: "publisher-01",
  certificateNotAfter: "2031-01-01T00:00:00.000Z",
});

function capabilities(platform: "linux" | "macos", marker: string): RunnerCapabilities {
  const core = {
    runnerId: `runner-${platform}-1`,
    platform,
    architecture: platform === "macos" ? "arm64" as const : "x86_64" as const,
    osVersion: platform === "macos" ? "macos-15.5" : "ubuntu-24.04",
    runnerImageDigest: sha(marker),
    godotVersion: "4.6.2-stable",
    godotBinaryDigest: sha(platform === "macos" ? "b" : "c"),
    exportTemplatesDigest: sha(platform === "macos" ? "d" : "e"),
    gpu: "virtual-vulkan",
    display: "virtual" as const,
    audio: "virtual" as const,
    installedAutonomousAgents: [] as readonly string[],
    steamClientConnector: null,
  };
  return Object.freeze({ ...core, capabilityDigest: createRunnerCapabilityDigest(core) });
}

const linux = capabilities("linux", "1");
const macos = capabilities("macos", "2");

function publication(overrides: Partial<RunnerToolchainPublication> = {}): RunnerToolchainPublication {
  return {
    schemaVersion: "deviludo.runner-toolchain-publication.v1",
    publicationId,
    tenantId,
    projectId,
    requiredGodotVersion: "4.6.2-stable",
    targetMatrix: ["linux", "macos"],
    runnerBindings: {
      linux: { runnerId: linux.runnerId, capabilityDigest: linux.capabilityDigest },
      macos: { runnerId: macos.runnerId, capabilityDigest: macos.capabilityDigest },
    },
    godotTestKitDigest: sha("3"),
    buildManifestDigest: sha("4"),
    sbomDigest: sha("5"),
    vulnerabilityScanDigest: sha("6"),
    assetLicenseLedgerDigest: sha("7"),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:10:00.000Z",
    ...overrides,
  };
}

class ToolchainClient implements PostgresWorkflowClient {
  releases = 0;
  commits = 0;
  rollbacks = 0;
  revision: null | { id: string; revision: number; payload: unknown; digest: string; createdAt: string } = null;
  operation: null | { requestDigest: string; publisherSpiffeId: string } = null;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    if (text === "BEGIN" || text.includes("set_config('app.tenant_id'")) return result([]);
    if (text === "COMMIT") { this.commits += 1; return result([]); }
    if (text === "ROLLBACK") { this.rollbacks += 1; return result([]); }
    if (text.includes("FROM deviludo.projects")) return result([{ id: projectId }] as unknown as Row[]);
    if (text.includes("FROM deviludo.runner_toolchain_publications publication")) {
      if (!this.operation || !this.revision) return result([]);
      return result([{
        request_digest: this.operation.requestDigest,
        publisher_spiffe_id: this.operation.publisherSpiffeId,
        runner_toolchain_revision_id: this.revision.id,
        runner_toolchain_digest: this.revision.digest,
        revision: this.revision.revision,
        payload: this.revision.payload,
        created_at: this.revision.createdAt,
      }] as unknown as Row[]);
    }
    if (text.includes("FROM deviludo.runner_registrations")) {
      return result([runnerRow(linux), runnerRow(macos)] as unknown as Row[]);
    }
    if (text.includes("COALESCE(MAX(revision)")) return result([{ revision: 1 }] as unknown as Row[]);
    if (text.includes("INSERT INTO deviludo.runner_toolchain_revisions")) {
      this.revision = {
        id: String(values[0]), revision: Number(values[3]), payload: JSON.parse(String(values[4])),
        digest: String(values[5]), createdAt: String(values[7]),
      };
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("INSERT INTO deviludo.runner_toolchain_publications")) {
      assert.equal(values[5], "4.6.2-stable");
      assert.equal(values[6], sha("3"));
      assert.equal(values[10], sha("7"));
      assert.deepEqual(values[11], ["linux", "macos"]);
      const bindings = JSON.parse(String(values[12]));
      assert.equal(bindings.linux.capabilityDigest, linux.capabilityDigest);
      this.operation = { requestDigest: String(values[3]), publisherSpiffeId: String(values[4]) };
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void { this.releases += 1; }
}

class ToolchainPool implements PostgresWorkflowPool {
  constructor(readonly client: ToolchainClient) {}
  async connect(): Promise<PostgresWorkflowClient> { return this.client; }
}

function runnerRow(value: RunnerCapabilities) {
  return {
    id: value.runnerId,
    spiffe_id: `spiffe://deviludo.test/e2e/${value.runnerId}`,
    certificate_fingerprint: value.platform === "linux" ? sha("8") : sha("9"),
    certificate_serial: `serial-${value.runnerId}`,
    certificate_not_after: "2031-01-01T00:00:00.000Z",
    platform: value.platform,
    architecture: value.architecture,
    capability_digest: value.capabilityDigest,
    capabilities: value,
    state: "ONLINE",
    registered_at: "2029-12-01T00:00:00.000Z",
    last_seen_at: "2030-01-01T00:04:00.000Z",
  };
}

function result<Row extends Record<string, unknown>>(rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount: rows.length, rows };
}

test("publishes and exactly replays one project Runner toolchain derived from admitted machines", async () => {
  const client = new ToolchainClient();
  const assignments: RunnerTenantAssignmentPolicy = {
    async authorize(input) {
      assert.equal(input.tenantId, tenantId);
      assert.ok([linux.runnerId, macos.runnerId].includes(input.runner.runnerId));
      return true;
    },
  };
  const publisher = new PostgresRunnerToolchainPublisher(new ToolchainPool(client), assignments, () => now);
  const first = await publisher.publish(publisherIdentity, publication());
  assert.equal(first.revision, 1);
  assert.equal(first.runnerToolchainRevisionId, client.revision?.id);
  assert.equal(first.runnerToolchainDigest, client.revision?.digest);
  assert.deepEqual((client.revision?.payload as { exportTemplates: unknown }).exportTemplates, {
    linux: linux.exportTemplatesDigest,
    macos: macos.exportTemplatesDigest,
  });
  assert.equal(client.commits, 1);
  assert.equal(client.rollbacks, 0);

  const replay = await publisher.publish(publisherIdentity, publication());
  assert.deepEqual(replay, first);
  assert.equal(client.commits, 2);
  assert.equal(client.releases, 2);
});

test("rejects capability drift or a Runner outside the signed tenant assignment atomically", async () => {
  const driftClient = new ToolchainClient();
  const publisher = new PostgresRunnerToolchainPublisher(
    new ToolchainPool(driftClient),
    { authorize: async () => true },
    () => now,
  );
  await assert.rejects(publisher.publish(publisherIdentity, publication({
    runnerBindings: {
      ...publication().runnerBindings,
      linux: { runnerId: linux.runnerId, capabilityDigest: sha("f") },
    },
  })), RunnerToolchainPublicationConflict);
  assert.equal(driftClient.revision, null);
  assert.equal(driftClient.rollbacks, 1);

  const assignmentClient = new ToolchainClient();
  const forbidden = new PostgresRunnerToolchainPublisher(
    new ToolchainPool(assignmentClient),
    { authorize: async (input) => input.runner.platform !== "macos" },
    () => now,
  );
  await assert.rejects(forbidden.publish(publisherIdentity, publication()), RunnerToolchainPublicationConflict);
  assert.equal(assignmentClient.revision, null);
  assert.equal(assignmentClient.rollbacks, 1);
});

test("publication parser rejects stale, unsorted and authority-expanded requests", () => {
  assert.throws(() => parseRunnerToolchainPublication(publication({
    targetMatrix: ["macos", "linux"],
  }), now), /invalid/);
  assert.throws(() => parseRunnerToolchainPublication(publication({
    expiresAt: "2030-01-01T00:05:00.000Z",
  }), now), /invalid/);
  assert.throws(() => parseRunnerToolchainPublication({
    ...publication(),
    exportTemplates: { linux: sha("0"), macos: sha("0") },
  }, now), /invalid/);
});
