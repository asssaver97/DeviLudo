import assert from "node:assert/strict";
import test from "node:test";
import { createAgentFailureDiagnostic, validateAgentFailureDiagnostic } from "../../../lib/agent/failure-diagnostics";

const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";

test("failure diagnostics are content-addressed, bounded and redact adapter secrets", () => {
  const diagnostic = createAgentFailureDiagnostic({
    runId,
    attemptId,
    stage: "RUNNING_AGENT",
    error: new Error("upstream failure api_key=sk-thrownsecret123"),
    process: {
      exitCode: 1,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 9_000,
      stderr: "never serialized stderr sk-stderrsecret123",
      droppedJsonLines: 3,
      adapter: {
        eventCount: 12,
        warningCount: 2,
        lastEventType: "failed",
        messages: ["Godot parse failed; api_key=sk-adaptersecret123"],
      },
    },
  });
  assert.match(diagnostic.diagnosticId, /^diag-[a-f0-9]{64}$/);
  assert.equal(diagnostic.kind, "AGENT_REPORTED_FAILURE");
  assert.equal(diagnostic.messages.some((message) => message.includes("sk-adaptersecret123")), false);
  assert.equal(diagnostic.messages.some((message) => message.includes("sk-thrownsecret123")), false);
  assert.match(diagnostic.messages.at(-1) ?? "", /Isolated Agent execution failed \(Error\)/);
  assert.equal("stderr" in diagnostic, false);
  assert.deepEqual(validateAgentFailureDiagnostic(diagnostic), diagnostic);
  assert.throws(() => validateAgentFailureDiagnostic({ ...diagnostic, warningCount: 3 }), /diagnostic is invalid/);
});

test("timeout diagnostics remain distinct from ordinary Agent failures", () => {
  const diagnostic = createAgentFailureDiagnostic({
    runId,
    attemptId,
    stage: "RUNNING_AGENT",
    error: new Error("Agent completion timed out"),
    process: {
      exitCode: null, signal: "SIGTERM", timedOut: true, cancelled: false, durationMs: 60_000,
      stderr: "", droppedJsonLines: 0,
      adapter: { eventCount: 4, warningCount: 0, lastEventType: "turn", messages: [] },
    },
  });
  assert.equal(diagnostic.kind, "TIMEOUT");
  assert.equal(diagnostic.timedOut, true);
});
