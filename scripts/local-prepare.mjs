import { mkdir, writeFile } from "node:fs/promises";

const coreUrl = process.env.DEVILUDO_CORE_API_URL ?? "http://127.0.0.1:8080";
const webToken = process.env.DEVILUDO_WEB_CORE_TOKEN ?? "local-web-to-core-token-0000000000000001";
const desired = [
  { poolKind: "WEB", operatingSystem: "linux", capabilities: ["CUSTOMER_WEB", "STREAMING_BFF"] },
  {
    poolKind: "CORE",
    operatingSystem: "linux",
    capabilities: ["BUSINESS_API", "WORKFLOW_SCHEDULER", "AGENT_GENERATION", "ARTIFACT_BUILD", "STEAM_PUBLISH"],
  },
  {
    poolKind: "E2E_MACOS",
    operatingSystem: "macos",
    capabilities: ["E2E_TEST", "ARTIFACT_SIGN", "STEAM_CLEAN_INSTALL"],
  },
];

const headers = { "content-type": "application/json", "x-deviludo-web-auth": webToken };
const stateResponse = await fetch(new URL("/v1/admin/server-pools", coreUrl), { headers });
if (!stateResponse.ok) throw new Error(`Core server-pool API returned ${stateResponse.status}`);
const state = await stateResponse.json();
const nodes = [...state.nodes];

for (const definition of desired) {
  let node = nodes.find(candidate => candidate.poolKind === definition.poolKind);
  if (!node) {
    const created = await fetch(new URL("/v1/admin/server-nodes", coreUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(definition),
    });
    if (!created.ok) throw new Error(`Failed to register ${definition.poolKind}: ${created.status}`);
    node = (await created.json()).node;
    nodes.push(node);
  }
  if (node.state !== "ACTIVE") {
    const activated = await fetch(new URL(`/v1/admin/server-nodes/${node.id}/activate`, coreUrl), {
      method: "POST",
      headers,
      body: "{}",
    });
    if (!activated.ok) throw new Error(`Failed to activate ${definition.poolKind}: ${activated.status}`);
    node = (await activated.json()).node;
    const index = nodes.findIndex(candidate => candidate.id === node.id);
    nodes[index] = node;
  }
}

const macNode = nodes.find(node => node.poolKind === "E2E_MACOS" && node.state === "ACTIVE");
if (!macNode) throw new Error("The local macOS E2E node was not registered");
await mkdir(new URL("../.deviludo/local/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../.deviludo/local/e2e-macos.json", import.meta.url),
  JSON.stringify({
    nodeId: macNode.id,
    poolKind: "E2E_MACOS",
    coreUrl,
    token: process.env.DEVILUDO_E2E_NODE_TOKEN ?? "local-e2e-node-token",
  }, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify({ prepared: true, macNodeId: macNode.id, pools: ["WEB", "CORE", "E2E_MACOS"] }));
