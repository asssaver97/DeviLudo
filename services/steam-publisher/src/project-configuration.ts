import { createHash, randomUUID } from "node:crypto";
import type { SteamConfigVault, SteamEnrollmentPrincipal } from "./enrollment-contracts";
import type {
  SteamPlatformDepots,
  SteamProjectConfigurationIntent,
  SteamProjectConfigurationStatus,
  SteamProjectConfigurationStore,
  SteamProjectConfigurationView,
  SteamProjectReleaseConfiguration,
} from "./project-configuration-contracts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const BETA_BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const SECRET_REF = /^vault:\/\/[A-Za-z0-9._~:/-]{2,500}$/;
const INTENT_TTL_MS = 5 * 60_000;

export class SteamProjectConfigurationCoordinator {
  readonly #store: SteamProjectConfigurationStore;
  readonly #vault: SteamConfigVault;
  readonly #publicOrigin: URL;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    store: SteamProjectConfigurationStore;
    vault: SteamConfigVault;
    publicOrigin: string;
    now?: () => Date;
  }>) {
    this.#store = options.store;
    this.#vault = options.vault;
    this.#publicOrigin = rootHttpsOrigin(options.publicOrigin);
    this.#now = options.now ?? (() => new Date());
  }

  probe(): Promise<void> {
    return this.#store.probe();
  }

  async status(principal: SteamEnrollmentPrincipal, projectId: string): Promise<SteamProjectConfigurationStatus> {
    validatePrincipal(principal);
    requireUuid(projectId, "project");
    const at = validNow(this.#now()).toISOString();
    const found = await this.#store.findStatus({
      tenantId: principal.tenantId,
      projectId,
      userId: principal.userId,
      sessionBindingDigest: digest(principal.sessionBinding),
      at,
    });
    if (found.pendingIntent) {
      return Object.freeze({
        state: "CONFIGURING",
        projectId,
        configurationUrl: this.#configurationUrl(found.pendingIntent.id, projectId),
        intentExpiresAt: found.pendingIntent.expiresAt,
        revision: null,
        steamAppId: null,
        betaBranch: null,
        platformDepots: Object.freeze({}),
        accountName: found.pendingIntent.buildSession.accountName,
        sessionExpiresAt: found.pendingIntent.buildSession.expiresAt,
      });
    }
    if (found.activeConfiguration) return statusFromConfiguration(found.activeConfiguration, at);
    return emptyStatus(projectId);
  }

  async begin(principal: SteamEnrollmentPrincipal, projectId: string, idempotencyKey: string): Promise<SteamProjectConfigurationView> {
    validatePrincipal(principal);
    requireUuid(projectId, "project");
    if (!ID.test(idempotencyKey)) throw new Error("Steam project configuration idempotency key is invalid");
    const createdAt = validNow(this.#now()).toISOString();
    const sessionBindingDigest = digest(principal.sessionBinding);
    const requestDigest = digest(canonicalJson({ tenantId: principal.tenantId, projectId, userId: principal.userId, sessionBindingDigest }));
    const intent = await this.#store.createIntent({
      id: randomUUID(), tenantId: principal.tenantId, projectId, userId: principal.userId,
      sessionBindingDigest, idempotencyKey, requestDigest, createdAt,
      expiresAt: new Date(Date.parse(createdAt) + INTENT_TTL_MS).toISOString(),
    });
    return this.#intentView(intent);
  }

  async completeConfiguration(input: Readonly<{
    principal: SteamEnrollmentPrincipal;
    projectId: string;
    intentId: string;
    steamAppId: string;
    betaBranch: string;
    platformDepots: SteamPlatformDepots;
    branchPassword: Uint8Array;
  }>): Promise<SteamProjectConfigurationView> {
    validatePrincipal(input.principal);
    requireUuid(input.projectId, "project");
    requireUuid(input.intentId, "configuration intent");
    const configuration = validateConfiguration(input.steamAppId, input.betaBranch, input.platformDepots);
    requireBranchPassword(input.branchPassword);
    try {
      const bindingDigest = digest(input.principal.sessionBinding);
      const intent = await this.#store.findIntent({ tenantId: input.principal.tenantId, projectId: input.projectId,
        intentId: input.intentId, userId: input.principal.userId, sessionBindingDigest: bindingDigest });
      if (intent.state === "COMPLETED") return this.#intentView(intent);
      const at = validNow(this.#now()).toISOString();
      if (intent.state !== "CONFIGURING" || Date.parse(intent.expiresAt) <= Date.parse(at)) throw new Error("Steam project configuration intent expired");
      if (intent.buildSession.state !== "ACTIVE" || Date.parse(intent.buildSession.expiresAt) <= Date.parse(at)
        || !intent.buildSession.allowedAppIds.includes(configuration.steamAppId)
        || !intent.buildSession.permissions.includes("EditAppMetadata")
        || !intent.buildSession.permissions.includes("PublishAppChanges")) {
        throw new Error("Steam build session does not authorize this App ID");
      }
      const depotConfigurationId = randomUUID();
      const releaseConfigurationId = randomUUID();
      let secretRef: string | null = null;
      try {
        const written = await this.#vault.write({
          path: `steam/beta-branch-password/${intent.tenantId}/${intent.projectId}/${releaseConfigurationId}`,
          plaintext: input.branchPassword,
        });
        if (!SECRET_REF.test(written.secretRef) || !/^sha256:[a-f0-9]{8}…[a-f0-9]{6}$/i.test(written.maskedFingerprint)) {
          throw new Error("Steam branch password Vault receipt is invalid");
        }
        secretRef = written.secretRef;
        const depotConfigurationDigest = digest(canonicalJson({ projectId: intent.projectId,
          steamAppId: configuration.steamAppId, platformDepots: configuration.platformDepots }));
        const releaseConfigurationDigest = digest(canonicalJson({ projectId: intent.projectId,
          steamAppId: configuration.steamAppId, steamBuildSessionId: intent.buildSession.id,
          depotConfigurationId, betaBranch: configuration.betaBranch,
          branchPasswordSecretRef: written.secretRef }));
        const stored = await this.#store.complete({ tenantId: intent.tenantId, projectId: intent.projectId,
          intentId: intent.id, userId: intent.userId, sessionBindingDigest: bindingDigest,
          steamAppId: configuration.steamAppId, betaBranch: configuration.betaBranch,
          platformDepots: configuration.platformDepots, branchPasswordSecretRef: written.secretRef,
          depotConfigurationId, depotConfigurationDigest, releaseConfigurationId, releaseConfigurationDigest,
          createdBy: intent.userId, at });
        secretRef = null;
        return Object.freeze({ intentId: intent.id, projectId: intent.projectId, state: "READY",
          configurationUrl: null, expiresAt: intent.expiresAt, revision: stored.revision });
      } catch (error) {
        if (secretRef) await this.#vault.revoke(secretRef).catch(() => undefined);
        throw error;
      }
    } finally { input.branchPassword.fill(0); }
  }

  #configurationUrl(intentId: string, projectId?: string): string {
    if (!projectId) throw new Error("Steam project configuration project ID is missing");
    return new URL(`/projects/${encodeURIComponent(projectId)}/steam-configuration/${encodeURIComponent(intentId)}`, this.#publicOrigin).href;
  }

  #intentView(intent: SteamProjectConfigurationIntent): SteamProjectConfigurationView {
    if (intent.state === "COMPLETED") return Object.freeze({ intentId: intent.id, projectId: intent.projectId,
      state: "READY", configurationUrl: null, expiresAt: intent.expiresAt, revision: null });
    if (intent.state !== "CONFIGURING") throw new Error("Steam project configuration intent is unavailable");
    return Object.freeze({ intentId: intent.id, projectId: intent.projectId, state: "CONFIGURING",
      configurationUrl: this.#configurationUrl(intent.id, intent.projectId), expiresAt: intent.expiresAt, revision: null });
  }
}

function statusFromConfiguration(value: SteamProjectReleaseConfiguration, at: string): SteamProjectConfigurationStatus {
  const ready = value.buildSessionState === "ACTIVE" && Date.parse(value.buildSessionExpiresAt) > Date.parse(at);
  return Object.freeze({ state: ready ? "READY" : "STALE_SESSION", projectId: value.projectId,
    configurationUrl: null, intentExpiresAt: null, revision: value.revision, steamAppId: value.steamAppId,
    betaBranch: value.betaBranch, platformDepots: Object.freeze({ ...value.platformDepots }), accountName: value.accountName,
    sessionExpiresAt: value.buildSessionExpiresAt });
}

function emptyStatus(projectId: string): SteamProjectConfigurationStatus {
  return Object.freeze({ state: "UNCONFIGURED", projectId, configurationUrl: null, intentExpiresAt: null,
    revision: null, steamAppId: null, betaBranch: null, platformDepots: Object.freeze({}), accountName: null, sessionExpiresAt: null });
}

function validateConfiguration(steamAppId: string, betaBranch: string, value: SteamPlatformDepots) {
  if (!NUMERIC_ID.test(steamAppId)) throw new Error("Steam App ID is invalid");
  if (!BETA_BRANCH.test(betaBranch) || betaBranch === "default" || betaBranch === "public") throw new Error("Steam Beta branch is invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Steam platform depots are invalid");
  const keys = Object.keys(value).sort();
  if (keys.length < 1 || keys.length > 3 || keys.some((key) => !["linux", "macos", "windows"].includes(key))) {
    throw new Error("Steam platform depots are invalid");
  }
  const platformDepots: Partial<Record<"windows" | "linux" | "macos", string>> = {};
  for (const key of keys as ("windows" | "linux" | "macos")[]) {
    const depotId = value[key];
    if (typeof depotId !== "string" || !NUMERIC_ID.test(depotId)) throw new Error("Steam depot ID is invalid");
    platformDepots[key] = depotId;
  }
  if (new Set(Object.values(platformDepots)).size !== keys.length) throw new Error("Steam depot IDs must be unique");
  return Object.freeze({ steamAppId, betaBranch, platformDepots: Object.freeze(platformDepots) });
}

function validatePrincipal(value: SteamEnrollmentPrincipal): void {
  if (!ID.test(value.tenantId) || !ID.test(value.userId) || value.sessionBinding.length < 32 || value.sessionBinding.length > 512
    || /[\u0000-\u001f\u007f]/.test(value.sessionBinding)) throw new Error("Steam project configuration principal is invalid");
}
function requireUuid(value: string, label: string): void { if (!UUID.test(value)) throw new Error(`Steam ${label} ID is invalid`); }
function requireBranchPassword(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength < 8 || value.byteLength > 64
    || [...value].some((byte) => byte < 0x21 || byte > 0x7e)) throw new Error("Steam Beta branch password is invalid");
}
function validNow(value: Date): Date { if (!Number.isFinite(value.getTime())) throw new Error("Steam project configuration clock is invalid"); return value; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown { if (Array.isArray(value)) return value.map(sort); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])); return value; }
function rootHttpsOrigin(value: string): URL { const url = new URL(value); if (url.protocol !== "https:" || !url.hostname || url.username || url.password
  || url.pathname !== "/" || url.search || url.hash) throw new Error("Steam project configuration public origin is invalid"); return url; }
