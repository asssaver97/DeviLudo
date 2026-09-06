import assert from "node:assert/strict";
import test from "node:test";
import { runScheduler, SchedulerTask } from "../services/core/src/scheduler";

test("slow lifecycle compaction does not block recovery or asset completion gates", { timeout: 5_000 }, async context => {
  context.mock.method(console, "log", () => undefined);
  const controller = new AbortController();
  let release!: () => void;
  const compacting = new Promise<void>(resolve => { release = resolve; });
  let recovered = 0;
  let advanced = 0;
  let lifecycleCalls = 0;
  let cleanupClaims = 0;
  let notifyTicks!: () => void;
  const ticks = new Promise<void>(resolve => { notifyTicks = resolve; });
  const repository = {
    recoverExpiredJobs: async () => { recovered += 1; return 0; },
    reconcileCapacity: async () => 0,
    cleanupExpiredAuthState: async () => 0,
    enqueueUnreachableSourceRevisions: async () => 0,
    claimSourceRevisionCleanup: async () => null,
    claimProjectCleanup: async () => { cleanupClaims += 1; return null; },
    claimObjectCleanup: async () => null,
    readAgentSettings: async () => null,
    assets: { advanceReadyWorkflows: async () => {
      advanced += 1;
      if (advanced === 3) { controller.abort(); notifyTicks(); }
      return 0;
    } },
  };
  const running = runScheduler(repository as never, {
    projectsRoot: "/tmp/deviludo-scheduler-test", pollMilliseconds: 1, assetGenerationPollMilliseconds: 1_000,
  } as never, controller.signal, undefined, {
    runOnce: async () => { lifecycleCalls += 1; await compacting; return null; },
  } as never);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([ticks, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("recovery tick was blocked by compaction")), 1_000);
    })]);
    assert.equal(recovered, 3);
    assert.equal(advanced, 3);
    assert.equal(lifecycleCalls, 1);
    assert.equal(cleanupClaims, 1, "project deletion waits until background writes settle");
  } finally {
    clearTimeout(timer);
    controller.abort();
    release();
    await running;
  }
});

test("background tasks cannot overlap and recover after a failed operation", async context => {
  context.mock.method(console, "error", () => undefined);
  const task = new SchedulerTask("test");
  let release!: () => void;
  let calls = 0;
  task.start(async () => { calls += 1; await new Promise<void>(resolve => { release = resolve; }); });
  task.start(async () => { calls += 100; });
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await task.wait();
  task.start(async () => { calls += 1; throw new Error("temporary provider failure"); });
  await task.wait();
  task.start(async () => { calls += 1; });
  await task.wait();
  assert.equal(calls, 3);
});
