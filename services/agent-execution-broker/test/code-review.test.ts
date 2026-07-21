import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentCodeReviewReceipt,
  parseAgentCodeReviewOutput,
  validateAgentCodeReviewReceipt,
} from "../../../lib/agent/code-review";

const passed = Object.freeze({
  schemaVersion: "deviludo.agent-code-review-output.v1" as const,
  verdict: "PASSED" as const,
  summary: "The implementation matches the approved specification and frozen plan.",
  findings: Object.freeze([
    Object.freeze({ severity: "WARNING" as const, code: "COVERAGE_NOTE", path: "main.gd", message: "Retain the platform E2E scenario." }),
  ]),
});

test("Agent code review output is strict and a passed review becomes a content-bound receipt", () => {
  assert.deepEqual(parseAgentCodeReviewOutput(passed), passed);
  const receipt = createAgentCodeReviewReceipt({
    output: passed,
    runId: "run-001",
    attemptId: "attempt-001",
    profileRevisionId: "profile-r1",
    installationId: "installation-r1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    model: "gateway/claude-sonnet-4-6-20250514",
    specRevisionId: "spec-r1",
    testPlanRevisionId: "plan-r1",
    sourceDigest: "b".repeat(64),
    reviewedAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(receipt.receiptId, "review-attempt-001");
  assert.equal(receipt.verdict, "PASSED");
  assert.equal(receipt.findingCount, 1);
  assert.equal(receipt.warningCount, 1);
  assert.match(receipt.reviewDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateAgentCodeReviewReceipt(receipt), receipt);
  assert.throws(() => validateAgentCodeReviewReceipt({ ...receipt, model: "latest" }), /contract is invalid/);
});

test("Agent code review blocks missing, malformed and contradictory verdicts", () => {
  assert.throws(() => parseAgentCodeReviewOutput({ ...passed, apiKey: "must-not-pass" }), /contract is invalid/);
  assert.throws(() => parseAgentCodeReviewOutput({ ...passed, verdict: "PASSED", findings: [{
    severity: "BLOCKING", code: "SPEC_DRIFT", path: null, message: "The implementation changes approved scope.",
  }] }), /contract is invalid/);
  const failed = parseAgentCodeReviewOutput({ ...passed, verdict: "FAILED", findings: [{
    severity: "BLOCKING", code: "SPEC_DRIFT", path: null, message: "The implementation changes approved scope.",
  }] });
  assert.throws(() => createAgentCodeReviewReceipt({
    output: failed, runId: "run-001", attemptId: "attempt-001", profileRevisionId: "profile-r1",
    installationId: "installation-r1", imageDigest: `sha256:${"a".repeat(64)}`,
    model: "gateway/claude-sonnet-4-6-20250514", specRevisionId: "spec-r1",
    testPlanRevisionId: "plan-r1", sourceDigest: "b".repeat(64), reviewedAt: "2030-01-01T00:00:00.000Z",
  }), /blocking findings/);
});
