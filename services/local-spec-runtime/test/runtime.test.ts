import assert from "node:assert/strict";
import test from "node:test";
import { createLocalSpecRuntimeServer } from "../src/server";

test("local specification runtime is an explicit non-listening loopback sidecar until started", () => {
  const server = createLocalSpecRuntimeServer();
  assert.equal(server.listening, false);
  assert.equal(server.requestTimeout, 300_000);
});
