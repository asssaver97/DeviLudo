import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptRunnerEvent,
  constrainPolicy,
  isFloatingModelAlias,
  transitionInstallation,
} from "../lib/domain/index.ts";

const sha = (character) => character.repeat(64);
const commit = "8b7e4a2b7c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";

test("lower scopes can narrow but cannot loosen the platform security policy", () => {
  const platform = {
    allowedAgentKinds: ["claude-code", "codex-cli"],
    allowedProviderIds: ["provider-a", "provider-b"],
    allowedTargetPlatforms: ["windows", "linux", "macos"],
    maxBudgetUsd: 100,
    maxTurns: 200,
    maxTimeoutSeconds: 14400,
    maxWorkspaceBytes: 4_000_000_000,
    requireSignedImages: true,
    requireExactModels: true,
    requireHttpsProviders: true,
    gatewayOnlyEgress: true,
    forbidDangerousBypass: true,
  };
  const effective = constrainPolicy(platform, {
    allowedAgentKinds: ["codex-cli"],
    maxBudgetUsd: 20,
    maxTurns: 50,
    requireSignedImages: false,
  });
  assert.deepEqual(effective.allowedAgentKinds, ["codex-cli"]);
  assert.equal(effective.maxBudgetUsd, 20);
  assert.equal(effective.maxTurns, 50);
  assert.equal(effective.requireSignedImages, true);
  assert.equal(effective.gatewayOnlyEgress, true);
  assert.equal(isFloatingModelAlias("sonnet"), true);
  assert.equal(isFloatingModelAlias("claude-sonnet-4-6-20250514"), false);
});

test("installation rollout requires a healthy 5% canary and a healthy 100% activation", () => {
  const installation = {
    id: "installation-1",
    registryId: "registry-claude",
    agentVersionId: "version-214",
    workerImageId: "image-214",
    imageDigest: `sha256:${sha("a")}`,
    workerPool: "dev-linux",
    rolloutPercent: 0,
    rollbackInstallationId: "installation-previous",
    health: "HEALTHY",
    state: "READY",
    createdAt: "2026-07-17T00:00:00.000Z",
  };
  const canary = transitionInstallation(installation, "CANARY", 5);
  assert.equal(canary.rolloutPercent, 5);
  assert.throws(() => transitionInstallation(canary, "ACTIVE", 25), /100%/);
  const active = transitionInstallation(canary, "ACTIVE", 100);
  assert.equal(active.state, "ACTIVE");
});

test("runner gate rejects stale fencing tokens and accepts only exact ordered results", () => {
  const lease = {
    attemptId: "attempt-1",
    runnerId: "runner-win-1",
    fencingToken: 9,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    commitSha: commit,
    sourceDigest: sha("a"),
    specRevisionId: "SPEC-008",
    specDigest: sha("b"),
    testPlanDigest: sha("c"),
    targetMatrix: ["windows"],
  };
  const cursor = { lastAcceptedSeqNo: 0, completedPlatforms: {}, terminal: false };
  const baseEvent = {
    attemptId: lease.attemptId,
    runnerId: lease.runnerId,
    fencingToken: 9,
    seqNo: 1,
    commitSha: commit,
    sourceDigest: sha("a"),
    platform: "windows",
    type: "STARTED",
    status: "RUNNING",
    artifactDigest: null,
    occurredAt: "2026-07-17T00:01:00.000Z",
  };
  const stale = acceptRunnerEvent(lease, cursor, { ...baseEvent, fencingToken: 8 }, "2026-07-17T00:01:01.000Z");
  assert.deepEqual(stale, { accepted: false, reason: "STALE_FENCING_TOKEN" });
  const accepted = acceptRunnerEvent(lease, cursor, baseEvent, "2026-07-17T00:01:01.000Z");
  assert.equal(accepted.accepted, true);
  const duplicate = acceptRunnerEvent(lease, accepted.cursor, baseEvent, "2026-07-17T00:01:02.000Z");
  assert.deepEqual(duplicate, { accepted: false, reason: "DUPLICATE_OR_OUT_OF_ORDER_SEQUENCE" });
});
