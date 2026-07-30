import { readFile } from "node:fs/promises";

const saved = JSON.parse(await readFile(new URL("../.deviludo/local/e2e-macos.json", import.meta.url), "utf8"));
process.env.NODE_ENV = "development";
process.env.DEVILUDO_E2E_NODE_ID = saved.nodeId;
process.env.DEVILUDO_E2E_POOL_KIND = saved.poolKind;
process.env.DEVILUDO_CORE_API_URL = saved.coreUrl;
process.env.DEVILUDO_E2E_NODE_TOKEN = saved.token;
process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE = saved.identityKeyFile;
process.env.DEVILUDO_E2E_ISOLATION_EXECUTOR = new URL("./executors/local-macos-isolation.mjs", import.meta.url).pathname;
process.env.DEVILUDO_E2E_TEST_EXECUTOR = new URL("./executors/local-macos-job.mjs", import.meta.url).pathname;
process.env.DEVILUDO_E2E_CLEAN_INSTALL_EXECUTOR = new URL("./executors/local-macos-job.mjs", import.meta.url).pathname;
const { main } = await import("../services/e2e-node/src/main.ts");
await main();
