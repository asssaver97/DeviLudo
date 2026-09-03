#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { arch, platform } from "node:process";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const ADAPTER_VERSION = "steamworks-2026-09-v1";
const REQUIRED_ASSET_KEYS = Object.freeze([
  "library.capsule", "library.header", "library.hero", "screenshot.1", "screenshot.2",
  "screenshot.3", "screenshot.4", "screenshot.5", "store.header_capsule", "store.main_capsule",
  "store.small_capsule", "store.vertical_capsule",
]);
const port = boundedInteger(process.env.DEVILUDO_STEAMWORKS_BRIDGE_PORT ?? "8792", 1024, 65535);
const token = process.env.DEVILUDO_STEAMWORKS_BRIDGE_TOKEN ?? "";
const profileRoot = resolve(process.env.DEVILUDO_STEAMWORKS_PROFILE_ROOT ?? ".deviludo/local/steamworks-sessions");
const receiptRoot = resolve(process.env.DEVILUDO_STEAMWORKS_RECEIPT_ROOT ?? ".deviludo/local/steamworks-sync-receipts");
const origin = normalizedSteamOrigin(process.env.DEVILUDO_STEAMWORKS_ORIGIN ?? "https://partner.steamgames.com");
if (process.env.NODE_ENV !== "test" && (platform !== "darwin" || arch !== "arm64")) {
  throw new Error("Steamworks automatic preparation currently requires local Apple Silicon");
}
if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) throw new Error("Steamworks bridge token is invalid");
await mkdir(profileRoot, { recursive: true, mode: 0o700 });
await chmod(profileRoot, 0o700);
await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
await chmod(receiptRoot, 0o700);

const contexts = new Map();
const syncOperations = new Map();
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  try {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ready: true });
    if (!authorized(request.headers["x-deviludo-bridge-token"])) return send(response, 401, { code: "UNAUTHORIZED" });
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const workspaceId = url.searchParams.get("workspaceId") ?? "";
    if (!UUID.test(workspaceId)) return send(response, 400, { code: "INVALID_WORKSPACE" });
    if (request.method === "GET" && url.pathname === "/internal/steamworks/session") {
      return send(response, 200, await sessionStatus(workspaceId, url.searchParams.get("verify") !== "0"));
    }
    if (request.method === "POST" && url.pathname === "/internal/steamworks/session") {
      await openWorkspace(workspaceId, true);
      return send(response, 200, await sessionStatus(workspaceId));
    }
    if (request.method === "DELETE" && url.pathname === "/internal/steamworks/session") {
      await clearWorkspace(workspaceId);
      return send(response, 200, { state: "DISCONNECTED", checkedAt: new Date().toISOString() });
    }
    if (request.method === "POST" && url.pathname === "/internal/steamworks/sync") {
      const body = await readJson(request, 512 * 1024);
      return send(response, 200, await synchronizedSteamworksSync(workspaceId, body));
    }
    return send(response, 404, { code: "NOT_FOUND" });
  } catch (error) {
    const failure = safeFailure(error);
    return send(response, failure.status, { code: failure.code, message: failure.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ event: "steamworks_bridge_ready", port, adapterVersion: ADAPTER_VERSION })}\n`);
});
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, async () => {
  await Promise.all([...contexts.values()].map(entry => entry.context.close().catch(() => undefined)));
  server.close(() => process.exit(0));
});

async function openWorkspace(workspaceId, visible) {
  const existing = contexts.get(workspaceId);
  if (existing && (!visible || existing.visible)) return existing;
  if (existing) {
    await existing.context.close().catch(() => undefined);
    contexts.delete(workspaceId);
  }
  const directory = join(profileRoot, workspaceId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const context = await chromium.launchPersistentContext(directory, {
    headless: !visible,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: false,
  });
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();
  const entry = { context, page, visible };
  contexts.set(workspaceId, entry);
  if (visible) await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  context.on("close", () => { if (contexts.get(workspaceId) === entry) contexts.delete(workspaceId); });
  return entry;
}

async function sessionStatus(workspaceId, verify = true) {
  let entry = contexts.get(workspaceId);
  if (!verify) return entry?.lastStatus
    ?? Object.freeze({ state: "DISCONNECTED", checkedAt: new Date().toISOString(), adapterVersion: ADAPTER_VERSION });
  if (!entry) {
    const directory = join(profileRoot, workspaceId);
    try { await access(directory); } catch {
      return Object.freeze({ state: "DISCONNECTED", checkedAt: new Date().toISOString(), adapterVersion: ADAPTER_VERSION });
    }
    entry = await openWorkspace(workspaceId, false);
  }
  await entry.page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
  const current = new URL(entry.page.url());
  const loggedIn = current.hostname === new URL(origin).hostname
    && !/login|twofactor|steamguard|captcha/i.test(`${current.pathname}${current.search}`)
    && await entry.page.locator("a[href*='logout'], [data-testid='account-menu'], #headerUserInfo").first().isVisible().catch(() => false);
  const status = Object.freeze({
    state: loggedIn ? "CONNECTED" : "LOGIN_REQUIRED",
    checkedAt: new Date().toISOString(),
    adapterVersion: ADAPTER_VERSION,
  });
  entry.lastStatus = status;
  return status;
}

async function clearWorkspace(workspaceId) {
  const entry = contexts.get(workspaceId);
  if (entry) await entry.context.close().catch(() => undefined);
  contexts.delete(workspaceId);
  const directory = join(profileRoot, workspaceId);
  if (resolve(directory).startsWith(`${profileRoot}/`)) await rm(directory, { recursive: true, force: true });
}

async function synchronizedSteamworksSync(workspaceId, body) {
  const request = validateSyncRequest(body);
  const key = `${workspaceId}:${request.operationId}`;
  const active = syncOperations.get(key);
  if (active) return active;
  const operation = syncSteamworks(workspaceId, request).finally(() => syncOperations.delete(key));
  syncOperations.set(key, operation);
  return operation;
}

async function syncSteamworks(workspaceId, request) {
  const cached = await readSyncReceipt(workspaceId, request);
  if (cached) return cached;
  const entry = contexts.get(workspaceId) ?? await openWorkspace(workspaceId, false);
  const status = await sessionStatus(workspaceId);
  if (status.state !== "CONNECTED") throw bridgeError("LOGIN_REQUIRED", "请在受管 Chromium 中完成 Steam 登录和 Steam Guard", 409);
  const files = await downloadAssets(request.assets);
  try {
    const savedFields = [];
    await fillGeneral(entry.page, request, savedFields);
    await fillLanguagesAndRequirements(entry.page, request, savedFields);
    await fillGraphics(entry.page, request, files, savedFields);
    await fillInstallation(entry.page, request, savedFields);
    await fillDepots(entry.page, request, savedFields);
    const receipt = Object.freeze({
      action: "SAVE",
      appId: request.appId,
      depotIds: Object.freeze(Object.values(request.depots)),
      savedFields: Object.freeze(savedFields),
      assets: Object.freeze(files.map(file => ({ key: file.key, sha256: file.sha256, sizeBytes: file.sizeBytes }))),
      adapterVersion: ADAPTER_VERSION,
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      savedAt: new Date().toISOString(),
    });
    await writeSyncReceipt(workspaceId, receipt);
    return receipt;
  } finally {
    await Promise.all(files.map(file => rm(file.path, { force: true })));
  }
}

async function readSyncReceipt(workspaceId, request) {
  try {
    const receipt = JSON.parse(await readFile(syncReceiptPath(workspaceId, request.operationId), "utf8"));
    if (receipt.operationId !== request.operationId || receipt.requestDigest !== request.requestDigest
      || receipt.appId !== request.appId || receipt.action !== "SAVE") {
      throw bridgeError("IDEMPOTENCY_CONFLICT", "Steamworks 幂等操作与原请求不一致", 409);
    }
    return Object.freeze(receipt);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeSyncReceipt(workspaceId, receipt) {
  const directory = join(receiptRoot, workspaceId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = syncReceiptPath(workspaceId, receipt.operationId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function syncReceiptPath(workspaceId, operationId) {
  return join(receiptRoot, workspaceId, `${operationId.slice("sha256:".length)}.json`);
}

const PAGE = Object.freeze({
  general: appId => `/apps/storeadmin/${appId}/general`,
  languages: appId => `/apps/storeadmin/${appId}/localization`,
  graphics: appId => `/apps/storeadmin/${appId}/assets`,
  installation: appId => `/apps/landing/${appId}/installation`,
  depots: appId => `/apps/depots/${appId}`,
});

async function fillGeneral(page, request, saved) {
  await openAppPage(page, request.appId, PAGE.general(request.appId));
  const expected = [];
  for (const localization of request.draft.localizations) {
    expected.push(await fillNamed(page, [`short_description_${localization.language}`, `short_description[${localization.language}]`], localization.shortDescription));
    expected.push(await fillNamed(page, [`about_${localization.language}`, `about_the_game[${localization.language}]`], localization.about));
    saved.push(`shortDescription.${localization.language}`, `about.${localization.language}`);
  }
  expected.push(await setMultiValue(page, ["tags", "genres"], request.draft.tags));
  expected.push(await setMultiValue(page, ["categories"], request.draft.categories));
  saved.push("tags", "categories");
  await saveAndVerify(page, request.appId, expected);
}

async function fillLanguagesAndRequirements(page, request, saved) {
  await openAppPage(page, request.appId, PAGE.languages(request.appId));
  const expected = [];
  for (const language of request.draft.languages) {
    expected.push(await setCheckbox(page, [`languages[${language.language}][interface]`, `${language.language}_interface`], language.interface));
    expected.push(await setCheckbox(page, [`languages[${language.language}][audio]`, `${language.language}_audio`], language.audio));
    expected.push(await setCheckbox(page, [`languages[${language.language}][subtitles]`, `${language.language}_subtitles`], language.subtitles));
  }
  for (const requirement of request.draft.systemRequirements) {
    expected.push(await fillNamed(page, [`requirements[${requirement.platform}][minimum]`, `${requirement.platform}_minimum`], requirement.minimum));
    if (requirement.recommended) expected.push(await fillNamed(page, [`requirements[${requirement.platform}][recommended]`, `${requirement.platform}_recommended`], requirement.recommended));
  }
  saved.push("languages", "systemRequirements");
  await saveAndVerify(page, request.appId, expected);
}

async function fillGraphics(page, request, files, saved) {
  await openAppPage(page, request.appId, PAGE.graphics(request.appId));
  for (const file of files) {
    const input = page.locator(`input[type=file][name="${cssEscape(file.key)}"], input[type=file][data-asset-key="${cssEscape(file.key)}"]`).first();
    if (await input.count() !== 1) throw bridgeError("DOM_DRIFT", `Steamworks 缺少素材字段 ${file.key}`, 409);
    await input.setInputFiles(file.path);
    saved.push(`asset.${file.key}`);
  }
  await saveAndVerify(page, request.appId, []);
}

async function fillInstallation(page, request, saved) {
  await openAppPage(page, request.appId, PAGE.installation(request.appId));
  const expected = [await fillNamed(page, ["install_directory", "installdir"], request.draft.installDirectory)];
  for (const [index, launch] of request.draft.launchOptions.entries()) {
    expected.push(await fillNamed(page, [`launch[${index}][executable]`, `launch_${index}_executable`], launch.executable));
    expected.push(await fillNamed(page, [`launch[${index}][arguments]`, `launch_${index}_arguments`], launch.arguments ?? ""));
    expected.push(await selectNamed(page, [`launch[${index}][platform]`, `launch_${index}_platform`], launch.platform));
  }
  saved.push("installDirectory", "launchOptions");
  await saveAndVerify(page, request.appId, expected);
}

async function fillDepots(page, request, saved) {
  await openAppPage(page, request.appId, PAGE.depots(request.appId));
  const pageText = await page.locator("body").innerText();
  const expected = [];
  for (const depot of request.draft.depots) {
    const depotId = request.depots[depot.platform];
    if (!depotId || !pageText.includes(depotId)) throw bridgeError("DEPOT_MISMATCH", `Steamworks 中找不到 ${depot.platform} Depot`, 409);
    expected.push(await fillNamed(page, [`depot[${depotId}][name]`, `depot_${depotId}_name`], depot.name));
    expected.push(await selectNamed(page, [`depot[${depotId}][os]`, `depot_${depotId}_os`], depot.platform));
    expected.push(await selectNamed(page, [`depot[${depotId}][architecture]`, `depot_${depotId}_architecture`], depot.architecture));
    saved.push(`depot.${depot.platform}.name`, `depot.${depot.platform}.os`, `depot.${depot.platform}.architecture`);
  }
  await saveAndVerify(page, request.appId, expected);
}

async function openAppPage(page, appId, path) {
  await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const url = new URL(page.url());
  if (/login|twofactor|steamguard|captcha/i.test(`${url.pathname}${url.search}`)) throw bridgeError("LOGIN_REQUIRED", "Steamworks 会话已失效", 409);
  if (!url.pathname.includes(appId)) throw bridgeError("APP_MISMATCH", "Steamworks 页面 App ID 与发布快照不一致", 409);
  if (await page.getByText(/captcha|steam guard|验证码/i).first().isVisible().catch(() => false)) throw bridgeError("LOGIN_REQUIRED", "Steamworks 要求额外验证", 409);
}

async function saveAndVerify(page, appId, expected) {
  const unsafe = page.getByRole("button", { name: /publish|release|submit for review|送审|发布/i });
  if (await unsafe.count()) { /* Presence is allowed; this adapter never acts on it. */ }
  const target = page.getByRole("button", { name: /^(save|保存)( changes)?$/i });
  if (await target.count() !== 1) throw bridgeError("DOM_DRIFT", "Steamworks Save 控件发生变化", 409);
  await target.click();
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  if (!new URL(page.url()).pathname.includes(appId)) throw bridgeError("APP_MISMATCH", "保存后离开了目标 App", 409);
  const failure = await page.getByText(/failed|error|保存失败/i).first().isVisible().catch(() => false);
  if (failure) throw bridgeError("SAVE_FAILED", "Steamworks 拒绝了 Save", 409);
  await page.reload({ waitUntil: "domcontentloaded" });
  for (const { name, value: expectedValue } of expected) {
    const control = page.locator(`[name="${cssEscape(name)}"]`);
    if (await control.count() !== 1) throw bridgeError("READBACK_FAILED", `保存后找不到字段 ${name}`, 409);
    const actualValue = await control.evaluate(element => {
      const input = element;
      if (input instanceof HTMLInputElement && input.type === "checkbox") return input.checked;
      if (input instanceof HTMLSelectElement && input.multiple) return [...input.selectedOptions].map(option => option.value);
      return input.value;
    });
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) throw bridgeError("READBACK_FAILED", `Steamworks 未保存字段 ${name}`, 409);
  }
}

async function fillNamed(page, names, value) {
  const locator = named(page, names, "input:not([type=file]), textarea");
  if (await locator.count() !== 1) throw bridgeError("DOM_DRIFT", `Steamworks 字段 ${names[0]} 发生变化`, 409);
  await locator.fill(String(value));
  return { name: await locator.getAttribute("name"), value: String(value) };
}
async function selectNamed(page, names, value) {
  const locator = named(page, names, "select");
  if (await locator.count() !== 1) throw bridgeError("DOM_DRIFT", `Steamworks 选项 ${names[0]} 发生变化`, 409);
  await locator.selectOption(String(value));
  return { name: await locator.getAttribute("name"), value: String(value) };
}
async function setCheckbox(page, names, checked) {
  const locator = named(page, names, 'input[type="checkbox"]');
  if (await locator.count() !== 1) throw bridgeError("DOM_DRIFT", `Steamworks 复选框 ${names[0]} 发生变化`, 409);
  if (checked) await locator.check(); else await locator.uncheck();
  return { name: await locator.getAttribute("name"), value: Boolean(checked) };
}
async function setMultiValue(page, names, values) {
  const locator = named(page, names, "select");
  if (await locator.count() !== 1) throw bridgeError("DOM_DRIFT", `Steamworks 多选字段 ${names[0]} 发生变化`, 409);
  await locator.selectOption(values.map(String));
  return { name: await locator.getAttribute("name"), value: values.map(String) };
}
function named(page, names, selector) {
  const selectors = selector.split(",").map(value => value.trim()).filter(Boolean);
  return page.locator(names.flatMap(name => selectors.map(value => `${value}[name="${cssEscape(name)}"]`)).join(", "));
}

async function downloadAssets(assets) {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-steam-assets-"));
  const files = [];
  try {
    for (const asset of assets) {
      const response = await fetch(asset.url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw bridgeError("ASSET_DOWNLOAD_FAILED", `素材 ${asset.key} 下载失败`, 409);
      const content = Buffer.from(await response.arrayBuffer());
      if (content.length !== asset.sizeBytes || `sha256:${createHash("sha256").update(content).digest("hex")}` !== asset.sha256) {
        throw bridgeError("ASSET_INTEGRITY_FAILED", `素材 ${asset.key} 大小或摘要不匹配`, 409);
      }
      const path = join(directory, `${files.length + 1}.png`);
      await writeFile(path, content, { mode: 0o600 });
      files.push({ ...asset, path });
    }
    return files;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function validateSyncRequest(value) {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (!/^sha256:[0-9a-f]{64}$/.test(String(body.operationId ?? ""))
    || !/^sha256:[0-9a-f]{64}$/.test(String(body.requestDigest ?? ""))) {
    throw bridgeError("INVALID_REQUEST", "同步操作标识无效", 400);
  }
  if (!/^\d{1,12}$/.test(String(body.appId ?? ""))) throw bridgeError("INVALID_REQUEST", "App ID 无效", 400);
  if (!body.depots || typeof body.depots !== "object" || !body.draft || typeof body.draft !== "object") throw bridgeError("INVALID_REQUEST", "同步请求不完整", 400);
  for (const [platform, depotId] of Object.entries(body.depots)) {
    if (!["linux", "windows", "macos"].includes(platform) || !/^\d{1,12}$/.test(String(depotId))) throw bridgeError("INVALID_REQUEST", "Depot 映射无效", 400);
  }
  if (!Array.isArray(body.assets) || body.assets.length < 1 || body.assets.some(asset => !asset || typeof asset !== "object"
    || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(String(asset.key ?? "")) || typeof asset.url !== "string"
    || !/^https?:\/\//.test(asset.url) || !/^sha256:[0-9a-f]{64}$/.test(String(asset.sha256 ?? ""))
    || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > 20 * 1024 * 1024)) {
    throw bridgeError("INVALID_REQUEST", "素材清单无效", 400);
  }
  const assetKeys = body.assets.map(asset => String(asset.key)).sort();
  if (JSON.stringify(assetKeys) !== JSON.stringify(REQUIRED_ASSET_KEYS)) {
    throw bridgeError("INVALID_REQUEST", "Steam Store/Library 素材快照不完整", 400);
  }
  validateDraft(body.draft, body.depots);
  const digest = `sha256:${createHash("sha256").update(JSON.stringify({
    appId: body.appId, depots: body.depots, draft: body.draft,
    assets: body.assets.map(asset => ({ key: asset.key, sha256: asset.sha256, sizeBytes: asset.sizeBytes })),
  })).digest("hex")}`;
  if (digest !== body.requestDigest) throw bridgeError("INVALID_REQUEST", "同步请求摘要不匹配", 400);
  return body;
}

function validateDraft(draft, depots) {
  const keys = Object.keys(draft).sort();
  const expected = ["artwork", "categories", "depots", "installDirectory", "languages", "launchOptions",
    "localizations", "schemaVersion", "screenshots", "systemRequirements", "tags"];
  if (JSON.stringify(keys) !== JSON.stringify(expected) || draft.schemaVersion !== "deviludo.steam-delivery-draft.v1"
    || !Array.isArray(draft.localizations) || !Array.isArray(draft.languages)
    || !Array.isArray(draft.systemRequirements) || !Array.isArray(draft.launchOptions)
    || !Array.isArray(draft.depots) || !Array.isArray(draft.screenshots) || draft.screenshots.length !== 5
    || !Array.isArray(draft.tags) || !Array.isArray(draft.categories)
    || typeof draft.installDirectory !== "string") {
    throw bridgeError("INVALID_REQUEST", "Steam 草稿 Schema 无效", 400);
  }
  const forbidden = /^(?:app_?id|depot_?id|id|api.?key|authorization|cookie|credential|password|secret|token)$/i;
  const visit = candidate => {
    if (Array.isArray(candidate)) return candidate.forEach(visit);
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (forbidden.test(key)) throw bridgeError("INVALID_REQUEST", `Steam 草稿不能包含 ${key}`, 400);
      visit(child);
    }
  };
  visit(draft);
  const languageCodes = draft.languages.map(item => item?.language);
  const localizationCodes = draft.localizations.map(item => item?.language);
  if (!languageCodes.includes("english") || new Set(languageCodes).size !== languageCodes.length
    || new Set(localizationCodes).size !== localizationCodes.length
    || JSON.stringify([...languageCodes].sort()) !== JSON.stringify([...localizationCodes].sort())) {
    throw bridgeError("INVALID_REQUEST", "Steam 草稿语言映射无效", 400);
  }
  const depotPlatforms = draft.depots.map(item => item?.platform);
  if (new Set(depotPlatforms).size !== depotPlatforms.length
    || depotPlatforms.some(platform => !["linux", "windows", "macos"].includes(platform) || !depots[platform])) {
    throw bridgeError("INVALID_REQUEST", "Steam 草稿 Depot 映射无效", 400);
  }
}

function authorized(value) {
  if (typeof value !== "string") return false;
  const left = Buffer.from(value); const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}
function normalizedSteamOrigin(value) {
  const url = new URL(value);
  const fixture = process.env.NODE_ENV === "test" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!fixture && (url.protocol !== "https:" || url.hostname !== "partner.steamgames.com")) || url.username || url.password || url.search || url.hash) throw new Error("Steamworks origin is invalid");
  return url.origin;
}
function bridgeError(code, message, status) { const error = new Error(message); error.code = code; error.status = status; return error; }
function safeFailure(error) { return { code: typeof error?.code === "string" ? error.code : "BRIDGE_FAILED", message: typeof error?.message === "string" ? error.message.slice(0, 500) : "Steamworks bridge failed", status: Number.isInteger(error?.status) ? error.status : 500 }; }
function send(response, status, value) { response.statusCode = status; response.end(JSON.stringify(value)); }
function boundedInteger(value, minimum, maximum) { const number = Number(value); if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error("Port is invalid"); return number; }
function cssEscape(value) { return String(value).replace(/["\\]/g, match => `\\${match}`); }
async function readJson(request, maximum) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > maximum) throw bridgeError("REQUEST_TOO_LARGE", "请求过大", 413); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
