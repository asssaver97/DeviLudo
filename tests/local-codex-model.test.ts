import assert from "node:assert/strict";
import test from "node:test";
// Runtime-only local bootstrap helper; exercised through Node's native ESM loader.
// @ts-expect-error The deployment helper intentionally has no production TS surface.
import { selectCodexAccountDefaultModel } from "../scripts/local-codex-model.mjs";
import { resolveCodexExecutionModel } from "@/services/core/src/codex-cli";

test("local Codex default selection requires the current CLI cache and picks the visible priority", () => {
  const cache = {
    client_version: "0.147.0",
    models: [
      { slug: "hidden-model", priority: 0, visibility: "hide" },
      { slug: "gpt-secondary", priority: 2, visibility: "list" },
      { slug: "gpt-primary", priority: 1, visibility: "list" },
    ],
  };
  assert.equal(selectCodexAccountDefaultModel(cache, "0.147.0"), "gpt-primary");
  assert.equal(selectCodexAccountDefaultModel(cache, "0.148.0"), null);
  assert.equal(selectCodexAccountDefaultModel({ ...cache, models: [{ slug: "bad model", priority: 1 }] }, "0.147.0"), null);
});

test("Codex execution preserves account-default unless valid local metadata freezes it", () => {
  assert.equal(resolveCodexExecutionModel("account-default", ""), "account-default");
  assert.equal(resolveCodexExecutionModel("account-default", "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(resolveCodexExecutionModel("custom-model", "gpt-5.6-sol"), "custom-model");
  assert.throws(() => resolveCodexExecutionModel("account-default", "bad model"), /metadata is invalid/);
});
