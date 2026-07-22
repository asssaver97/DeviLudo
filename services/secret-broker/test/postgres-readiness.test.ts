import assert from "node:assert/strict";
import test from "node:test";
import { PostgresReadinessFixture } from "../../temporal/test/postgres-readiness-fixture";
import { probePostgresRelations } from "../../temporal/src/postgres-readiness";
import { PostgresInferenceCredentialAuthority } from "../src/authority";
import { PostgresSecretBrokerStore } from "../src/store";

const cases = [
  {
    name: "secret persistence",
    relations: ["secret_broker_audit", "secret_broker_records"],
    create: (pool: PostgresReadinessFixture) => new PostgresSecretBrokerStore(pool),
  },
  {
    name: "inference credential authority",
    relations: [
      "admin_catalog_state", "agent_run_provider_failovers", "inference_provider_revisions",
      "inference_run_authorizations", "projects",
    ],
    create: (pool: PostgresReadinessFixture) => new PostgresInferenceCredentialAuthority(pool),
  },
] as const;

for (const fixture of cases) {
  test(`Secret Broker ${fixture.name} readiness requires its exact relations`, async () => {
    const ready = new PostgresReadinessFixture();
    await fixture.create(ready).probe();
    assert.deepEqual(ready.observedRelations(), fixture.relations);
    assert.equal(ready.releases, 1);

    const missing = new PostgresReadinessFixture(fixture.relations.at(-1)!);
    await assert.rejects(fixture.create(missing).probe());
    assert.equal(missing.releases, 1);
  });
}

test("shared PostgreSQL readiness rejects noncanonical relation input and releases query failures", async () => {
  let connects = 0;
  const unused = { async connect() { connects += 1; throw new Error("must not connect"); } };
  for (const relations of [["z_table", "a_table"], ["safe_table", "safe_table"], ["unsafe;table"]]) {
    await assert.rejects(probePostgresRelations(unused, relations, () => new Error("invalid relations")), /invalid relations/);
  }
  assert.equal(connects, 0);

  let releases = 0;
  await assert.rejects(probePostgresRelations({ async connect() { return {
    async query() { throw new Error("database unavailable"); },
    release() { releases += 1; },
  }; } }, ["safe_table"], () => new Error("invalid relations")), /database unavailable/);
  assert.equal(releases, 1);
});
