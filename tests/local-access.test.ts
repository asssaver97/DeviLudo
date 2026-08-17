import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_ACTOR_ID, LOCAL_WORKSPACE_ID, localAccessContext } from "../services/core/src/access";

test("self-hosted access is a stable local operator context", () => {
  const first = localAccessContext();
  const second = localAccessContext();
  assert.equal(first, second);
  assert.equal(first.actorId, LOCAL_ACTOR_ID);
  assert.equal(first.workspace.id, LOCAL_WORKSPACE_ID);
  assert.equal(first.workspace.name, "Local workspace");
  assert.equal(first.actorLabel, "Local operator");
  assert.equal(Object.isFrozen(first), true);
});
