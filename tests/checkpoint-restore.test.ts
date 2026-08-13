import assert from "node:assert/strict";
import test from "node:test";
import { decideAgentCheckpointRestore } from "@/services/sandbox-executor/src/checkpoint-restore";

const base = {
  checkpoint: {
    state: "PARTIAL" as const,
    originJobId: "30000000-0000-4000-8000-000000000001",
    specificationDigest: "sha256:spec-a",
    sourceDigest: "sha256:source-a",
    localDirectoryBaseDigest: "sha256:local-a",
    digest: "sha256:checkpoint",
  },
  jobId: "30000000-0000-4000-8000-000000000002",
  specificationDigest: "sha256:spec-a",
  inputSourceDigest: "sha256:local-a",
  localDirectoryBaseDigest: "sha256:local-a",
};

test("restores a matching partial checkpoint from an earlier retry job", () => {
  assert.deepEqual(decideAgentCheckpointRestore(base), { action: "RESTORE" });
});

test("discards an older job checkpoint after the local project changes", () => {
  const result = decideAgentCheckpointRestore({ ...base, localDirectoryBaseDigest: "sha256:local-new" });
  assert.equal(result.action, "DISCARD_STALE");
  assert.match(result.reason ?? "", /LOCAL_PROJECT_CHANGED/);
});

test("keeps concurrent local change protection for the current job", () => {
  const result = decideAgentCheckpointRestore({
    ...base,
    jobId: base.checkpoint.originJobId,
    localDirectoryBaseDigest: "sha256:local-new",
  });
  assert.equal(result.action, "REJECT_CURRENT_JOB");
  assert.match(result.reason ?? "", /LOCAL_PROJECT_CHANGED/);
});

test("discards older checkpoints whose frozen specification or source changed", () => {
  assert.equal(decideAgentCheckpointRestore({ ...base, specificationDigest: "sha256:spec-b" }).action, "DISCARD_STALE");
  assert.equal(decideAgentCheckpointRestore({
    ...base,
    localDirectoryBaseDigest: null,
    inputSourceDigest: "sha256:source-b",
  }).action, "DISCARD_STALE");
});

test("a completed current-job checkpoint accepts its base or completed digest only", () => {
  const checkpoint = { ...base.checkpoint, state: "AGENT_COMPLETE" as const };
  const current = { ...base, checkpoint, jobId: checkpoint.originJobId };
  assert.equal(decideAgentCheckpointRestore(current).action, "RESTORE");
  assert.equal(decideAgentCheckpointRestore({ ...current, localDirectoryBaseDigest: checkpoint.digest }).action, "RESTORE");
  assert.equal(decideAgentCheckpointRestore({ ...current, localDirectoryBaseDigest: "sha256:other" }).action, "REJECT_CURRENT_JOB");
});
