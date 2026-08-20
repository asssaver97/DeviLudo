import { readFile } from "node:fs/promises";

const saved = JSON.parse(await readFile(new URL("../.deviludo/local/e2e-macos.json", import.meta.url), "utf8"));
const reportPreparation = createPreparationReporter(saved);
try {
  const { prepareLocalTartE2e } = await import("./local-tart-prepare.mjs");
  await prepareLocalTartE2e({
    refresh: process.argv.includes("--refresh-e2e-vm"),
    onProgress: reportPreparation,
  });
} catch (error) {
  await reportPreparation({
    state: "FAILED",
    stage: "FAILED",
    progress: 100,
    message: `macOS E2E 准备失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 240),
  });
  throw error;
}
process.env.NODE_ENV = "development";
process.env.DEVILUDO_E2E_NODE_ID = saved.nodeId;
process.env.DEVILUDO_E2E_POOL_KIND = saved.poolKind;
process.env.DEVILUDO_CORE_API_URL = saved.coreUrl;
process.env.DEVILUDO_E2E_NODE_TOKEN = saved.token;
process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE = saved.identityKeyFile;
process.env.DEVILUDO_E2E_TOOL_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
process.env.DEVILUDO_E2E_JOB_ROOT = saved.jobRoot;
process.env.DEVILUDO_E2E_ISOLATION_EXECUTOR = new URL("./executors/local-tart-isolation.mjs", import.meta.url).pathname;
process.env.DEVILUDO_E2E_TEST_EXECUTOR = new URL("../deploy/assets/e2e-job-executor.mjs", import.meta.url).pathname;
process.env.DEVILUDO_E2E_GUEST_RUNNER = new URL("./executors/local-tart-guest-runner.mjs", import.meta.url).pathname;
const { main } = await import("../services/e2e-node/src/main.ts");
await main();

function createPreparationReporter(configuration) {
  let queue = Promise.resolve();
  let lastSignature = "";
  return payload => {
    const signature = `${payload.state}:${payload.stage}:${payload.progress}:${payload.message}`;
    if (signature === lastSignature) return queue;
    lastSignature = signature;
    queue = queue.then(async () => {
      try {
        const response = await fetch(new URL(`/v1/e2e/nodes/${configuration.nodeId}/preparation`, configuration.coreUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-deviludo-node-auth": configuration.token,
            "x-deviludo-node-id": configuration.nodeId,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Core returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
      } catch (error) {
        console.warn(`[DeviLudo:E2E] 准备进度上报失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return queue;
  };
}
