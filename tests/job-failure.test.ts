import assert from "node:assert/strict";
import test from "node:test";
import { jobFailurePresentation, technicalFailureDetail } from "../components/ProjectStudio";

test("legacy executor progress noise is not presented as the failure cause", () => {
  const legacy = [
    'Sandbox executor failed: DEVILUDO_PROGRESS:{"kind":"PHASE","content":"starting"}',
    'DEVILUDO_PROGRESS:{"kind":"AGENT_OUTPUT","content":"working"}',
    'DEVILUDO_PROGRESS:{"kind":"AGENT_OUTPUT","content":"truncated',
  ].join("\n");

  assert.equal(
    technicalFailureDetail(legacy),
    "EXECUTOR_DIAGNOSTIC_TRUNCATED: The previous executor did not preserve the actual failure reason",
  );
});

test("new executor diagnostics remain visible without progress events", () => {
  assert.equal(
    technicalFailureDetail("Sandbox executor failed: claude exited 1: maximum turns reached"),
    "Sandbox executor failed: claude exited 1: maximum turns reached",
  );
});

test("an orphaned source revision is not misreported as an unavailable Provider", () => {
  const presentation = jobFailurePresentation({
    kind: "AGENT_GENERATION",
    lastError: "Sandbox executor failed: Source revision is already published with different content",
  } as never, (chinese: string) => chinese);
  assert.match(presentation.reason, /未登记 revision/);
  assert.match(presentation.action, /回收未登记 revision/);
  assert.doesNotMatch(presentation.reason, /Provider/);
});
