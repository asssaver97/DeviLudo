import { acceptRunnerEvent, type RunnerEvent, type RunnerEventCursor, type RunnerLease } from "@/lib/domain/e2e";

const digest = "a".repeat(64);
const commit = "8b7e4a2b7c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";

type RunnerDemoState = {
  lease: RunnerLease;
  cursor: RunnerEventCursor;
};

const globalRunner = globalThis as typeof globalThis & { __deviludoRunnerDemo?: RunnerDemoState };

export function getRunnerDemoState(): RunnerDemoState {
  globalRunner.__deviludoRunnerDemo ??= {
    lease: {
      attemptId: "attempt-e2e-823",
      runnerId: "runner-win-03",
      fencingToken: 17,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      commitSha: commit,
      sourceDigest: digest,
      specRevisionId: "SPEC-007",
      specDigest: "b".repeat(64),
      testPlanDigest: "c".repeat(64),
      targetMatrix: ["windows"],
    },
    cursor: { lastAcceptedSeqNo: 0, completedPlatforms: {}, terminal: false },
  };
  return globalRunner.__deviludoRunnerDemo;
}

export function acceptDemoRunnerEvent(event: RunnerEvent, receivedAt: string) {
  const state = getRunnerDemoState();
  const decision = acceptRunnerEvent(state.lease, state.cursor, event, receivedAt);
  if (decision.accepted) state.cursor = decision.cursor;
  return decision;
}

export const runnerDemoFixture = Object.freeze({ digest, commit });
