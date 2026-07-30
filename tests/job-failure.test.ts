import assert from "node:assert/strict";
import test from "node:test";
import { technicalFailureDetail } from "../components/ProjectStudio";

test("legacy executor progress noise is not presented as the failure cause", () => {
  const legacy = [
    'Sandbox executor failed: DEVILUDO_PROGRESS:{"kind":"PHASE","content":"starting"}',
    'DEVILUDO_PROGRESS:{"kind":"AGENT_OUTPUT","content":"working"}',
    'DEVILUDO_PROGRESS:{"kind":"AGENT_OUTPUT","content":"truncated',
  ].join("\n");

  assert.equal(
    technicalFailureDetail(legacy),
    "EXECUTOR_DIAGNOSTIC_TRUNCATED: 旧执行器未保留真实失败原因",
  );
});

test("new executor diagnostics remain visible without progress events", () => {
  assert.equal(
    technicalFailureDetail("Sandbox executor failed: claude exited 1: maximum turns reached"),
    "Sandbox executor failed: claude exited 1: maximum turns reached",
  );
});
