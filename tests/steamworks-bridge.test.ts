import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const appId = "123456";

test("managed Steamworks bridge saves fixture pages, reads them back, and never publishes", async () => {
  const fixtureRequests: string[] = [];
  const values = new Map<string, string | string[]>();
  const fixture = createServer(async (request, response) => {
    fixtureRequests.push(`${request.method} ${request.url}`);
    if (request.url === "/asset.png") {
      response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length }); response.end(PNG); return;
    }
    if (request.method === "POST") {
      const contentType = String(request.headers["content-type"] ?? "");
      const body = await readBody(request);
      if (contentType.startsWith("application/x-www-form-urlencoded")) {
        const parsed = new URLSearchParams(body.toString());
        for (const key of new Set(parsed.keys())) values.set(key, parsed.getAll(key).length > 1 ? parsed.getAll(key) : parsed.get(key) ?? "");
      }
    }
    response.writeHead(200, { "content-type": "text/html" }); response.end(pageFor(request.url ?? "/", values));
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const fixturePort = (fixture.address() as { port: number }).port;
  const bridgePort = fixturePort + 1;
  const token = randomBytes(32).toString("base64url");
  const profileRoot = await mkdtemp(join(tmpdir(), "steamworks-bridge-test-"));
  const bridge = spawn(process.execPath, ["scripts/local-steamworks-bridge-server.mjs"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", DEVILUDO_STEAMWORKS_BRIDGE_PORT: String(bridgePort),
      DEVILUDO_STEAMWORKS_BRIDGE_TOKEN: token, DEVILUDO_STEAMWORKS_PROFILE_ROOT: profileRoot,
      DEVILUDO_STEAMWORKS_RECEIPT_ROOT: join(profileRoot, "receipts"),
      DEVILUDO_STEAMWORKS_ORIGIN: `http://127.0.0.1:${fixturePort}` },
  });
  let diagnostics = "";
  bridge.stderr.on("data", chunk => { diagnostics += chunk.toString(); });
  try {
    await waitForHealth(bridgePort);
    const assetUrl = `http://127.0.0.1:${fixturePort}/asset.png`;
    const sha256 = `sha256:${createHash("sha256").update(PNG).digest("hex")}`;
    const assets = ["store.header_capsule", "store.small_capsule", "store.main_capsule", "store.vertical_capsule",
      "library.capsule", "library.hero", "library.header", "screenshot.1", "screenshot.2", "screenshot.3", "screenshot.4", "screenshot.5"]
      .map(key => ({ key, url: assetUrl, sha256, sizeBytes: PNG.length }));
    const draft = fixtureDraft();
    const operationId = `sha256:${createHash("sha256").update("fixture-operation").digest("hex")}`;
    const requestDigest = `sha256:${createHash("sha256").update(JSON.stringify({
      appId, depots: { macos: "654321" }, draft,
      assets: assets.map(asset => ({ key: asset.key, sha256: asset.sha256, sizeBytes: asset.sizeBytes })),
    })).digest("hex")}`;
    const body = JSON.stringify({ operationId, requestDigest, appId, depots: { macos: "654321" }, assets, draft });
    const response = await fetch(`http://127.0.0.1:${bridgePort}/internal/steamworks/sync?workspaceId=${workspaceId}`, {
      method: "POST", headers: { "content-type": "application/json", "x-deviludo-bridge-token": token },
      body,
    });
    const receipt = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, `${JSON.stringify(receipt)} ${diagnostics}`);
    assert.equal(receipt.action, "SAVE");
    assert.equal(receipt.appId, appId);
    assert.equal(receipt.adapterVersion, "steamworks-2026-09-v1");
    assert.ok((receipt.savedFields as string[]).includes("installDirectory"));
    assert.ok(fixtureRequests.some(value => value === `POST /apps/storeadmin/${appId}/general`));
    assert.ok(fixtureRequests.some(value => value === `POST /apps/depots/${appId}`));
    assert.equal(fixtureRequests.some(value => /publish|review|release/i.test(value)), false);
    const requestCount = fixtureRequests.length;
    const replay = await fetch(`http://127.0.0.1:${bridgePort}/internal/steamworks/sync?workspaceId=${workspaceId}`, {
      method: "POST", headers: { "content-type": "application/json", "x-deviludo-bridge-token": token }, body,
    });
    assert.equal(replay.status, 200);
    assert.equal(fixtureRequests.length, requestCount, "an identical operation must reuse its verified Save receipt");
  } finally {
    bridge.kill("SIGTERM");
    await new Promise(resolve => bridge.once("exit", resolve));
    await new Promise(resolve => fixture.close(resolve));
    await rm(profileRoot, { recursive: true, force: true });
  }
});

function fixtureDraft() {
  return {
    schemaVersion: "deviludo.steam-delivery-draft.v1",
    localizations: [{ language: "english", shortDescription: "Verified short copy", about: "Verified long copy" }],
    tags: ["Indie"], categories: ["Single-player"],
    languages: [{ language: "english", interface: true, audio: false, subtitles: true }],
    systemRequirements: [{ platform: "macos", minimum: "Apple Silicon", recommended: "Apple Silicon" }],
    installDirectory: "Verified Game",
    launchOptions: [{ platform: "macos", executable: "Verified Game.app", arguments: "" }],
    depots: [{ platform: "macos", name: "macOS Depot", architecture: "arm64" }],
    artwork: { landscapePrompt: "text-free landscape key art for verified gameplay", portraitPrompt: "text-free portrait key art for verified gameplay" },
    screenshots: [1, 2, 3, 4, 5].map(index => ({ checkpointId: `checkpoint-${index}` })),
  };
}

function pageFor(url: string, values: Map<string, string | string[]>) {
  const path = new URL(url, "http://fixture").pathname;
  const logout = '<a href="/logout">logout</a>';
  if (path === "/") return `${logout}<main>Steamworks fixture</main>`;
  const form = (content: string, multipart = false) => `${logout}<form method="post"${multipart ? ' enctype="multipart/form-data"' : ""}>${content}<button type="submit">Save</button><button type="button">Publish</button></form>`;
  if (path.endsWith("/general")) return form([
    input("short_description_english", values), textarea("about_english", values),
    select("tags", ["Indie", "Action"], values, true), select("categories", ["Single-player", "Multi-player"], values, true),
  ].join(""));
  if (path.endsWith("/localization")) return form([
    checkbox("languages[english][interface]", values), checkbox("languages[english][audio]", values), checkbox("languages[english][subtitles]", values),
    textarea("requirements[macos][minimum]", values), textarea("requirements[macos][recommended]", values),
  ].join(""));
  if (path.endsWith("/assets")) return form(["store.header_capsule", "store.small_capsule", "store.main_capsule", "store.vertical_capsule",
    "library.capsule", "library.hero", "library.header", "screenshot.1", "screenshot.2", "screenshot.3", "screenshot.4", "screenshot.5"]
    .map(name => `<input type="file" name="${name}">`).join(""), true);
  if (path.endsWith("/installation")) return form(input("install_directory", values) + input("launch[0][executable]", values) + input("launch[0][arguments]", values)
    + select("launch[0][platform]", ["macos"], values));
  if (path.includes("/depots/")) return form(`654321${input("depot[654321][name]", values)}${select("depot[654321][os]", ["macos"], values)}${select("depot[654321][architecture]", ["arm64"], values)}`);
  return `${logout}<main>Unknown fixture</main>`;
}
function input(name: string, values: Map<string, string | string[]>) { return `<input name="${name}" value="${escapeHtml(String(values.get(name) ?? ""))}">`; }
function textarea(name: string, values: Map<string, string | string[]>) { return `<textarea name="${name}">${escapeHtml(String(values.get(name) ?? ""))}</textarea>`; }
function checkbox(name: string, values: Map<string, string | string[]>) { return `<input type="checkbox" name="${name}"${values.has(name) ? " checked" : ""}>`; }
function select(name: string, options: string[], values: Map<string, string | string[]>, multiple = false) { const selected = new Set(Array.isArray(values.get(name)) ? values.get(name) as string[] : [String(values.get(name) ?? "")]); return `<select name="${name}"${multiple ? " multiple" : ""}>${options.map(option => `<option value="${option}"${selected.has(option) ? " selected" : ""}>${option}</option>`).join("")}</select>`; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
async function readBody(request: AsyncIterable<Buffer>) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
async function waitForHealth(port: number) { for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* starting */ } await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error("Steamworks bridge did not start"); }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
