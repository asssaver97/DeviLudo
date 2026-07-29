import assert from "node:assert/strict";
import test from "node:test";
import { detectAgentRuntimes, parseRuntimeVersion } from "@/services/core/src/agent-runtime-detection";

test("runtime version parsing accepts Claude Code and Codex CLI output", () => {
  assert.equal(parseRuntimeVersion("2.1.201 (Claude Code)"), "2.1.201");
  assert.equal(parseRuntimeVersion("codex-cli 0.146.0-alpha.3.1"), "0.146.0-alpha.3.1");
  assert.equal(parseRuntimeVersion("not a version"), null);
});

test("runtime detection reports installed versions without exposing executable paths", async () => {
  const detected = await detectAgentRuntimes({
    DEVILUDO_AGENT_RUNTIME_DETECTION_SCOPE: "LOCAL_HOST",
    DEVILUDO_CLAUDE_CODE_VERSION: "2.1.201 (Claude Code)",
    DEVILUDO_CODEX_CLI_VERSION: "NOT_INSTALLED",
  }, async () => { throw new Error("override must avoid probing"); });
  assert.deepEqual(detected, [
    { kind: "CLAUDE_CODE", installed: true, version: "2.1.201", scope: "LOCAL_HOST" },
    { kind: "CODEX_CLI", installed: false, version: null, scope: "LOCAL_HOST" },
  ]);
});

test("runtime detection probes the Core environment when no local override exists", async () => {
  const detected = await detectAgentRuntimes({}, async command => command === "codex"
    ? "codex-cli 0.146.0-alpha.3.1"
    : null);
  assert.deepEqual(detected, [
    { kind: "CLAUDE_CODE", installed: false, version: null, scope: "CORE_RUNTIME" },
    { kind: "CODEX_CLI", installed: true, version: "0.146.0-alpha.3.1", scope: "CORE_RUNTIME" },
  ]);
});
