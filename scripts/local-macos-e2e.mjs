import { readFile } from "node:fs/promises";

const saved = JSON.parse(await readFile(new URL("../.deviludo/local/e2e-macos.json", import.meta.url), "utf8"));
process.env.NODE_ENV = "development";
process.env.DEVILUDO_E2E_NODE_ID = saved.nodeId;
process.env.DEVILUDO_E2E_POOL_KIND = saved.poolKind;
process.env.DEVILUDO_CORE_API_URL = saved.coreUrl;
process.env.DEVILUDO_E2E_NODE_TOKEN = saved.token;
const { main } = await import("../services/e2e-node/src/main.ts");
await main();
