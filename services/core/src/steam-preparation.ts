import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { extractAndValidateEvidenceBundle } from "@/scripts/e2e-evidence.mjs";
import type { AgentSecretStore } from "./agent-settings";
import { runCodexImage } from "./codex-cli";
import { composeImagePrompt, generateAssetImage, validateGeneratedImage } from "./image-generation";
import type { CoreObjectStore } from "./object-store";
import type { CoreRepository, SteamPreparationLease, SteamStoreAssetRecord } from "./repository";

const MAX_EVIDENCE_BYTES = 512 * 1024 * 1024;
export const STEAM_STORE_ASSET_SIZES = Object.freeze([
  { key: "store.header_capsule", kind: "STORE", width: 920, height: 430, master: "landscape" },
  { key: "store.small_capsule", kind: "STORE", width: 462, height: 174, master: "landscape" },
  { key: "store.main_capsule", kind: "STORE", width: 1232, height: 706, master: "landscape" },
  { key: "store.vertical_capsule", kind: "STORE", width: 748, height: 896, master: "portrait" },
  { key: "library.capsule", kind: "LIBRARY", width: 600, height: 900, master: "portrait" },
  { key: "library.hero", kind: "LIBRARY", width: 3840, height: 1240, master: "landscape" },
  { key: "library.header", kind: "LIBRARY", width: 920, height: 430, master: "landscape" },
] as const);

export type SteamPreparationDependencies = Readonly<{
  repository: CoreRepository;
  objectStore: CoreObjectStore;
  secrets: AgentSecretStore;
  projectsRoot: string;
  bridgeUrl: string | null;
  bridgeToken: string | null;
  fetchImpl?: typeof fetch;
}>;

export async function runSteamPreparationOnce(dependencies: SteamPreparationDependencies, signal?: AbortSignal) {
  const lease = await dependencies.repository.claimSteamPreparation(1800);
  if (!lease) return null;
  try {
    if (!dependencies.bridgeUrl || !dependencies.bridgeToken) throw preparationError("BROWSER_BRIDGE_UNAVAILABLE", "当前部署未配置受管 Steamworks 浏览器");
    let assets: readonly SteamStoreAssetRecord[];
    if (lease.state === "GENERATING_ASSETS") {
      const settings = await dependencies.repository.readAgentSettings();
      if (!settings) throw preparationError("IMAGE_RUNTIME_UNAVAILABLE", "未配置可用的 Agent/Image Runtime");
      const credential = await dependencies.secrets.readApiKey(settings.credentialSecretRef);
      if (!credential) throw preparationError("IMAGE_RUNTIME_UNAVAILABLE", "图片 Runtime 凭证不可用");
      assets = await generateSteamStoreAssets(dependencies, lease, settings, credential);
      await dependencies.repository.replaceSteamStoreAssets(lease, assets);
      if (!await dependencies.repository.markSteamPreparationSyncing(lease)) throw preparationError("LEASE_EXPIRED", "Steam 准备租约已失效");
    } else {
      assets = await dependencies.repository.readSteamStoreAssetsForLease(lease);
      if (assets.length !== STEAM_STORE_ASSET_SIZES.length + 5) {
        throw preparationError("ASSET_SNAPSHOT_INCOMPLETE", "Steam 同步恢复时素材快照不完整");
      }
    }
    const authorized = await Promise.all(assets.map(async asset => Object.freeze({
      key: asset.key,
      ...await dependencies.objectStore.authorizeSteamStoreAsset({
        workspaceId: lease.workspaceId, projectId: lease.projectId,
        bucket: asset.bucket, key: asset.objectKey, sha256: asset.sha256, sizeBytes: asset.sizeBytes,
      }),
    })));
    const receipt = await syncBridge(dependencies, lease, authorized, signal);
    if (!await dependencies.repository.completeSteamPreparation(lease, receipt)) throw preparationError("LEASE_EXPIRED", "Steam 保存完成时租约已失效");
    return Object.freeze({ workflowId: lease.workflowId, state: "SAVED" as const, assetCount: assets.length });
  } catch (error) {
    const failure = normalizedPreparationFailure(error);
    await dependencies.repository.failSteamPreparation(lease, failure.code, failure.message, failure.loginRequired).catch(() => undefined);
    return Object.freeze({ workflowId: lease.workflowId, state: failure.loginRequired ? "LOGIN_REQUIRED" as const : "FAILED" as const, error: failure.message });
  }
}

async function generateSteamStoreAssets(
  dependencies: SteamPreparationDependencies,
  lease: SteamPreparationLease,
  settings: NonNullable<Awaited<ReturnType<CoreRepository["readAgentSettings"]>>>,
  credential: string,
): Promise<readonly SteamStoreAssetRecord[]> {
  const draft = lease.draft as Record<string, unknown>;
  const artwork = record(draft.artwork);
  const [landscape, portrait] = await Promise.all([
    generateMaster(settings, credential, String(artwork.landscapePrompt ?? ""), "1536x1024"),
    generateMaster(settings, credential, String(artwork.portraitPrompt ?? ""), "1024x1536"),
  ]);
  const logo = await existingProjectLogo(dependencies.projectsRoot, lease.sourceRelativePath);
  const created: SteamStoreAssetRecord[] = [];
  for (const size of STEAM_STORE_ASSET_SIZES) {
    const content = await renderCapsule(size.master === "landscape" ? landscape : portrait, lease.projectName, size.width, size.height, logo);
    created.push(await storeAsset(dependencies.objectStore, lease, size.key, size.kind, "GENERATED", size.width, size.height, content));
  }
  const screenshots = await selectedE2eScreenshots(dependencies, lease);
  for (const [index, screenshot] of screenshots.entries()) {
    const content = await sharp(screenshot).resize(1920, 1080, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 }, kernel: "lanczos3" })
      .png({ compressionLevel: 9 }).toBuffer();
    created.push(await storeAsset(dependencies.objectStore, lease, `screenshot.${index + 1}`, "SCREENSHOT", "E2E", 1920, 1080, content));
  }
  return Object.freeze(created);
}

async function generateMaster(settings: NonNullable<Awaited<ReturnType<CoreRepository["readAgentSettings"]>>>, credential: string, prompt: string, dimensions: string) {
  if (prompt.trim().length < 20) throw preparationError("INVALID_DRAFT", "主视觉提示词不完整");
  const request = { assetKey: "steam-key-art", assetType: "illustration", description: "Steam key art", generationPrompt: prompt, dimensions, frameCount: null } as const;
  const generated = settings.agentRuntime === "CODEX_CLI"
    ? validateGeneratedImage(await runCodexImage({ baseUrl: settings.baseUrl, credential, model: settings.primaryModel, prompt: composeImagePrompt(request), timeoutMs: 300_000 }))
    : settings.imageModel
      ? await generateAssetImage({ baseUrl: settings.baseUrl, model: settings.imageModel, apiKey: credential }, request)
      : null;
  if (!generated) throw preparationError("IMAGE_RUNTIME_UNAVAILABLE", "当前 Agent 连接没有可用的图片后端");
  return generated.content;
}

export async function renderCapsule(master: Buffer, title: string, width: number, height: number, logo: Buffer | null = null): Promise<Buffer> {
  const fontSize = Math.max(24, Math.round(Math.min(width, height) * 0.115));
  const safeTitle = escapeXml(title.slice(0, 80));
  const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="${Math.round(height * 0.62)}" width="${width}" height="${Math.round(height * 0.38)}" fill="rgba(0,0,0,.42)"/>${logo ? "" : `<text x="50%" y="82%" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="800" fill="white" stroke="black" stroke-width="${Math.max(2, Math.round(fontSize / 18))}" paint-order="stroke">${safeTitle}</text>`}</svg>`);
  const composites: sharp.OverlayOptions[] = [{ input: overlay }];
  if (logo) {
    const normalizedLogo = await sharp(logo).resize({ width: Math.round(width * .72), height: Math.round(height * .25), fit: "inside", withoutEnlargement: true }).png().toBuffer();
    composites.push({ input: normalizedLogo, gravity: "south" });
  }
  return sharp(master).resize(width, height, { fit: "cover", position: "attention", kernel: "lanczos3" })
    .composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

async function existingProjectLogo(projectsRoot: string, sourceRelativePath: string): Promise<Buffer | null> {
  const root = resolve(projectsRoot, sourceRelativePath);
  const boundedRoot = resolve(projectsRoot);
  if (!root.startsWith(`${boundedRoot}${sep}`)) throw preparationError("INVALID_SOURCE", "项目源码路径无效");
  const paths = await readdir(root, { recursive: true, encoding: "utf8" });
  const candidate = paths.filter(path => /(?:^|\/)(?:logo|wordmark|title[-_ ]?logo)\.(?:png|jpe?g|webp|svg)$/i.test(path))
    .sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
  if (!candidate) return null;
  const path = resolve(root, candidate);
  if (!path.startsWith(`${root}${sep}`)) throw preparationError("INVALID_SOURCE", "项目 Logo 路径无效");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > 10 * 1024 * 1024) return null;
  const content = await readFile(path);
  await sharp(content).metadata();
  return content;
}

async function selectedE2eScreenshots(dependencies: SteamPreparationDependencies, lease: SteamPreparationLease): Promise<readonly Buffer[]> {
  const draftScreenshots = Array.isArray(lease.draft.screenshots) ? lease.draft.screenshots.map(record) : [];
  const wanted = draftScreenshots.map(item => String(item.checkpointId ?? ""));
  if (wanted.length !== 5 || new Set(wanted).size !== 5) throw preparationError("SCREENSHOTS_INSUFFICIENT", "商店需要五张不同的 E2E 截图");
  const found = new Map<string, Buffer>();
  const digests = new Set<string>();
  const temporaryRoot = join(dependencies.projectsRoot, "steam-preparation-tmp");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  for (const revision of Object.values(lease.e2eRevision)) {
    const artifactId = String(record(revision).artifactId ?? "");
    if (!artifactId) continue;
    const artifact = await dependencies.repository.readProjectArtifact(lease.workspaceId, lease.projectId, artifactId);
    if (!artifact || artifact.kind !== "E2E_REPORT" || artifact.e2eEvidence?.result !== "PASSED") continue;
    const archive = await dependencies.objectStore.readProjectArtifact({ workspaceId: lease.workspaceId, projectId: lease.projectId,
      ...artifact.object, maximumBytes: MAX_EVIDENCE_BYTES });
    const directory = await mkdtemp(join(temporaryRoot, "evidence-"));
    try {
      const archivePath = join(directory, "evidence.zip"); const extractionRoot = join(directory, "extracted");
      await writeFile(archivePath, archive, { mode: 0o600 });
      const validated = await extractAndValidateEvidenceBundle(archivePath, extractionRoot, MAX_EVIDENCE_BYTES);
      for (const checkpoint of Array.isArray(validated.report.checkpoints) ? validated.report.checkpoints : []) {
        const id = typeof checkpoint.checkpointId === "string" ? checkpoint.checkpointId : "";
        if (!wanted.includes(id) || found.has(id) || typeof checkpoint.screenshot !== "string") continue;
        const path = resolve(extractionRoot, checkpoint.screenshot);
        const bounded = relative(extractionRoot, path);
        if (!bounded || bounded === ".." || bounded.startsWith(`..${sep}`)) throw preparationError("INVALID_EVIDENCE", "E2E 截图越过证据目录");
        const content = await readFile(path);
        const pixels = await sharp(content).rotate().resize(320, 180, { fit: "fill" }).raw().toBuffer();
        const digest = createHash("sha256").update(pixels).digest("hex");
        if (digests.has(digest)) continue;
        digests.add(digest); found.set(id, content);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (wanted.some(id => !found.has(id))) throw preparationError("SCREENSHOTS_INSUFFICIENT", "最新 PASS E2E 中无法取得五张不同的真实游戏画面");
  return Object.freeze(wanted.map(id => found.get(id)!));
}

async function storeAsset(objectStore: CoreObjectStore, lease: SteamPreparationLease, key: string,
  kind: SteamStoreAssetRecord["kind"], sourceKind: SteamStoreAssetRecord["sourceKind"], width: number, height: number, content: Buffer) {
  const stored = await objectStore.putSteamStoreAsset({ workspaceId: lease.workspaceId, projectId: lease.projectId,
    workflowId: lease.workflowId, assetKey: key, content });
  return Object.freeze({ key, kind, sourceKind, width, height, bucket: stored.bucket, objectKey: stored.key,
    sha256: stored.sha256, sizeBytes: stored.sizeBytes });
}

async function syncBridge(dependencies: SteamPreparationDependencies, lease: SteamPreparationLease,
  assets: readonly Readonly<{ key: string; url: string; sha256: string; sizeBytes: number }>[], signal?: AbortSignal) {
  const requestDigest = `sha256:${createHash("sha256").update(JSON.stringify({
    appId: lease.appId, depots: lease.depots, draft: lease.draft,
    assets: assets.map(asset => ({ key: asset.key, sha256: asset.sha256, sizeBytes: asset.sizeBytes })),
  })).digest("hex")}`;
  const operationId = `sha256:${createHash("sha256").update(`${lease.workflowId}:${lease.draftRevision}`).digest("hex")}`;
  const response = await (dependencies.fetchImpl ?? fetch)(`${dependencies.bridgeUrl}/internal/steamworks/sync?workspaceId=${lease.workspaceId}`, {
    method: "POST", headers: { "content-type": "application/json", "x-deviludo-bridge-token": dependencies.bridgeToken! },
    body: JSON.stringify({ operationId, requestDigest, appId: lease.appId, depots: lease.depots, draft: lease.draft, assets }), redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(9 * 60_000)]) : AbortSignal.timeout(9 * 60_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw preparationError(String(body.code ?? "STEAMWORKS_SYNC_FAILED"), String(body.message ?? "Steamworks 自动填写失败"), response.status === 409 && body.code === "LOGIN_REQUIRED");
  return validatedBridgeReceipt(body, lease, assets, operationId, requestDigest);
}

function validatedBridgeReceipt(body: Record<string, unknown>, lease: SteamPreparationLease,
  assets: readonly Readonly<{ key: string; sha256: string; sizeBytes: number }>[], operationId: string, requestDigest: string) {
  const depotIds = Array.isArray(body.depotIds) ? body.depotIds.map(String).sort() : [];
  const expectedDepotIds = Object.values(lease.depots).map(String).sort();
  const savedFields = Array.isArray(body.savedFields) ? body.savedFields.map(String) : [];
  const receiptAssets = Array.isArray(body.assets) ? body.assets.map(record) : [];
  const expectedAssets = [...assets].sort((left, right) => left.key.localeCompare(right.key));
  const actualAssets = receiptAssets.map(asset => ({ key: String(asset.key ?? ""), sha256: String(asset.sha256 ?? ""),
    sizeBytes: Number(asset.sizeBytes) })).sort((left, right) => left.key.localeCompare(right.key));
  if (body.action !== "SAVE" || body.appId !== lease.appId || body.adapterVersion !== "steamworks-2026-09-v1"
    || body.operationId !== operationId || body.requestDigest !== requestDigest
    || JSON.stringify(depotIds) !== JSON.stringify(expectedDepotIds)
    || savedFields.length < 1 || savedFields.length > 200 || new Set(savedFields).size !== savedFields.length
    || savedFields.some(field => !/^[A-Za-z0-9._-]{1,160}$/.test(field))
    || JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets.map(asset => ({ key: asset.key, sha256: asset.sha256, sizeBytes: asset.sizeBytes })))
    || typeof body.savedAt !== "string" || !Number.isFinite(Date.parse(body.savedAt))) {
    throw preparationError("INVALID_SAVE_RECEIPT", "Steamworks 保存回执无效");
  }
  return Object.freeze({ action: "SAVE", appId: lease.appId, depotIds: Object.freeze(depotIds),
    savedFields: Object.freeze(savedFields), assets: Object.freeze(actualAssets),
    adapterVersion: "steamworks-2026-09-v1", operationId, requestDigest, savedAt: body.savedAt });
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function escapeXml(value: string) { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!); }
function preparationError(code: string, message: string, loginRequired = false) { return Object.assign(new Error(message), { code, loginRequired }); }
function normalizedPreparationFailure(error: unknown) { const value = error as { code?: unknown; loginRequired?: unknown; message?: unknown }; return { code: typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code) ? value.code : "PREPARATION_FAILED", message: typeof value?.message === "string" ? value.message.slice(0, 2000) : "Steam 准备失败", loginRequired: value?.loginRequired === true || value?.code === "LOGIN_REQUIRED" }; }
