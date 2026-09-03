#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

if (process.env.DEVILUDO_REAL_STEAMWORKS_SMOKE !== "1") {
  throw new Error("Set DEVILUDO_REAL_STEAMWORKS_SMOKE=1 to run the opt-in real Steamworks Save smoke test");
}
const url = new URL(process.env.DEVILUDO_STEAMWORKS_SMOKE_BRIDGE_URL ?? "");
const token = process.env.DEVILUDO_STEAMWORKS_BRIDGE_TOKEN ?? "";
const workspaceId = process.env.DEVILUDO_STEAMWORKS_SMOKE_WORKSPACE_ID ?? "";
const testAppId = process.env.DEVILUDO_STEAMWORKS_TEST_APP_ID ?? "";
const payloadFile = process.env.DEVILUDO_STEAMWORKS_SMOKE_PAYLOAD_FILE ?? "";
if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
  || !/^[A-Za-z0-9_-]{40,200}$/.test(token)
  || !/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^\d{1,12}$/.test(testAppId)
  || !isAbsolute(payloadFile)) throw new Error("Real Steamworks smoke configuration is invalid");
const payload = JSON.parse(await readFile(payloadFile, "utf8"));
if (String(payload.appId ?? "") !== testAppId) throw new Error("Smoke payload does not target DEVILUDO_STEAMWORKS_TEST_APP_ID");
payload.requestDigest = `sha256:${createHash("sha256").update(JSON.stringify({
  appId: payload.appId, depots: payload.depots, draft: payload.draft,
  assets: Array.isArray(payload.assets) ? payload.assets.map(asset => ({ key: asset.key, sha256: asset.sha256, sizeBytes: asset.sizeBytes })) : [],
})).digest("hex")}`;
payload.operationId ??= payload.requestDigest;
const response = await fetch(new URL(`/internal/steamworks/sync?workspaceId=${workspaceId}`, url), {
  method: "POST", headers: { "content-type": "application/json", "x-deviludo-bridge-token": token },
  body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(10 * 60_000),
});
const receipt = await response.json();
if (!response.ok || receipt.action !== "SAVE" || String(receipt.appId) !== testAppId) throw new Error(`Steamworks smoke Save failed (${response.status})`);
console.log(JSON.stringify({ saved: true, appId: testAppId, adapterVersion: receipt.adapterVersion,
  savedFieldCount: Array.isArray(receipt.savedFields) ? receipt.savedFields.length : 0 }));
