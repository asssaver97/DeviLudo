import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentBaselineSourceReference, validateAgentSourceReference } from "@/services/sandbox-executor/src/source-revision";

const workspaceId = "30000000-0000-4000-8000-000000000003";
const projectId = "30000000-0000-4000-8000-000000000004";
const digest = `sha256:${"a".repeat(64)}`;

test("first Agent generation accepts an explicitly null source revision", () => {
  assert.equal(validateAgentSourceReference({
    sourceRevision: null,
    sourceRelativePath: null,
    sourceDigest: null,
    publishSourceRevision: 1,
  }, workspaceId, projectId), null);
  assert.equal(validateAgentSourceReference({ publishSourceRevision: 1 }, workspaceId, projectId), null);
});

test("subsequent Agent generation requires one complete deterministic source reference", () => {
  const relativePath = `workspaces/${workspaceId}/projects/${projectId}/revisions/r000000000007-${"a".repeat(16)}`;
  assert.deepEqual(validateAgentSourceReference({
    sourceRevision: 7,
    sourceRelativePath: relativePath,
    sourceDigest: digest,
  }, workspaceId, projectId), { revision: 7, relativePath, digest });

  assert.throws(() => validateAgentSourceReference({
    sourceRevision: 7,
    sourceRelativePath: relativePath,
    sourceDigest: null,
  }, workspaceId, projectId), /source revision is invalid/i);
  assert.throws(() => validateAgentSourceReference({
    sourceRevision: 7,
    sourceRelativePath: `${relativePath}-tampered`,
    sourceDigest: digest,
  }, workspaceId, projectId), /source revision is invalid/i);
});

test("workflow baseline source references use the same project-bound integrity contract", () => {
  const relativePath = `workspaces/${workspaceId}/projects/${projectId}/revisions/r000000000001-${"a".repeat(16)}`;
  assert.deepEqual(validateAgentBaselineSourceReference({
    baselineSourceRevision: 1,
    baselineSourceRelativePath: relativePath,
    baselineSourceDigest: digest,
  }, workspaceId, projectId), { revision: 1, relativePath, digest });
  assert.throws(() => validateAgentBaselineSourceReference({
    baselineSourceRevision: 1,
    baselineSourceRelativePath: relativePath.replace(projectId, "30000000-0000-4000-8000-000000000099"),
    baselineSourceDigest: digest,
  }, workspaceId, projectId), /baseline source revision is invalid/i);
});
