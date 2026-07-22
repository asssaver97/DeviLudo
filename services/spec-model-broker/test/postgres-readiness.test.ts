import assert from "node:assert/strict";
import test from "node:test";
import { PostgresReadinessFixture } from "../../temporal/test/postgres-readiness-fixture";
import { PostgresSpecModelOperationStore } from "../src/postgres-operations";
import { PostgresSpecModelProviderAuthority } from "../src/provider-authority";

const cases = [
  {
    name: "operation store",
    relations: ["spec_conversations", "spec_model_generation_operations", "spec_model_generation_reconciliations"],
    create: (pool: PostgresReadinessFixture) => new PostgresSpecModelOperationStore(pool),
  },
  {
    name: "Provider authority",
    relations: ["admin_catalog_state"],
    create: (pool: PostgresReadinessFixture) => new PostgresSpecModelProviderAuthority(pool),
  },
] as const;

for (const fixture of cases) {
  test(`Specification model ${fixture.name} readiness requires its exact relations`, async () => {
    const ready = new PostgresReadinessFixture();
    await fixture.create(ready).probe();
    assert.deepEqual(ready.observedRelations(), fixture.relations);
    assert.equal(ready.releases, 1);

    const missing = new PostgresReadinessFixture(fixture.relations.at(-1)!);
    await assert.rejects(fixture.create(missing).probe());
    assert.equal(missing.releases, 1);
  });
}
