import assert from "node:assert/strict";
import test from "node:test";
import { deriveMachineInstallationId } from "../scripts/machine-installation-id.mjs";

test("machine installation ID is stable for a host and scoped to DeviLudo", () => {
  const first = deriveMachineInstallationId("darwin", "9DACF9C7-CE90-52BC-A2AE-BF7579A02266");
  const repeated = deriveMachineInstallationId("DARWIN", "9dacf9c7-ce90-52bc-a2ae-bf7579a02266");
  const anotherMachine = deriveMachineInstallationId("darwin", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(first, repeated);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, anotherMachine);
  assert.doesNotMatch(first, /9dacf9c7|ce90|52bc/);
});
