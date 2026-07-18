import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve, sep } from "node:path";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { SignedRunnerJob } from "../../runner-control/src/contracts";
import { parseGodotHarnessResult, type GodotTestKitRunRequest, type GodotTestPlan } from "./contracts";
import type { GodotCommandEvidence, GodotDriverResult } from "./godot-driver";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z0-9_]{2,64}$/;

export const REQUIRED_TESTKIT_STEAM_ENV_NAMES = Object.freeze([
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_URL",
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_RUNNER_ID",
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_PLATFORM",
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_VERSION",
  "DEVILUDO_TESTKIT_STEAM_BRIDGE_VERSION",
  "DEVILUDO_TESTKIT_STEAM_CONTROLLER_CONTRACT_VERSION",
  "DEVILUDO_TESTKIT_STEAM_CONNECTOR_BINARY_DIGEST",
  "DEVILUDO_TESTKIT_STEAM_AUTOMATION_POLICY_DIGEST",
  "DEVILUDO_TESTKIT_STEAM_SUPPLY_CHAIN_EVIDENCE_DIGEST",
  "DEVILUDO_TESTKIT_STEAM_TLS_KEY_FILE",
  "DEVILUDO_TESTKIT_STEAM_TLS_CERT_FILE",
  "DEVILUDO_TESTKIT_STEAM_CA_FILE",
  "DEVILUDO_TESTKIT_STEAM_STAGING_ROOT",
] as const);

export const OPTIONAL_TESTKIT_STEAM_ENV_NAMES = Object.freeze([
  "DEVILUDO_TESTKIT_STEAM_TIMEOUT_SECONDS",
] as const);

export interface SteamInstalledGameDriver {
  run(input: {
    readonly request: GodotTestKitRunRequest;
    readonly plan: GodotTestPlan;
    readonly runRoot: string;
    readonly planPath: string;
  }): Promise<GodotDriverResult>;
}

export interface SteamInstalledGameConnectorTls {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface SteamInstalledGameConnectorIdentity {
  readonly runnerId: string;
  readonly platform: "windows" | "linux" | "macos";
  readonly version: string;
  readonly bridgeVersion: string;
  readonly controllerContractVersion: 1;
  readonly binaryDigest: string;
  readonly automationPolicyDigest: string;
  readonly supplyChainEvidenceDigest: string;
}

export type SteamInstalledGameConnectorHttp = (input: {
  readonly url: URL;
  readonly method: "GET" | "POST";
  readonly body: string;
  readonly tls: SteamInstalledGameConnectorTls;
  readonly timeoutMs: number;
}) => Promise<Readonly<{ statusCode: number; payload: unknown }>>;

/**
 * Calls a platform-owned Steam Client connector. The connector resolves only
 * the opaque install grant; no account, Guard, branch secret or config.vdf is
 * accepted by this client or forwarded to the game process.
 */
export class MtlsSteamInstalledGameDriver implements SteamInstalledGameDriver {
  readonly #endpoint: URL;
  readonly #tls: SteamInstalledGameConnectorTls;
  readonly #stagingRoot: string;
  readonly #timeoutMs: number;
  readonly #http: SteamInstalledGameConnectorHttp;
  readonly #expectedConnector: SteamInstalledGameConnectorIdentity;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: SteamInstalledGameConnectorTls;
    readonly stagingRoot: string;
    readonly expectedConnector: SteamInstalledGameConnectorIdentity;
    readonly timeoutMs?: number;
    readonly http?: SteamInstalledGameConnectorHttp;
  }) {
    this.#endpoint = strictOrigin(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#stagingRoot = absolutePath(options.stagingRoot, "Steam staging root");
    this.#expectedConnector = connectorIdentity(options.expectedConnector);
    this.#timeoutMs = integer(options.timeoutMs ?? 50 * 60_000, 30_000, 60 * 60_000);
    this.#http = options.http ?? steamInstalledGameConnectorHttpsJson;
  }

  async run(input: Parameters<SteamInstalledGameDriver["run"]>[0]): Promise<GodotDriverResult> {
    const execution = input.request.signedJob.payload.execution;
    if (execution.kind !== "STEAM_CLEAN_INSTALL") throw new Error("Steam installed-game driver requires a clean-install job");
    const jobDigest = sha256Canonical(input.request.signedJob.payload);
    const response = await this.#http({
      url: new URL("/v1/clean-install-executions", this.#endpoint),
      method: "POST",
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
      body: JSON.stringify({
        schemaVersion: "deviludo.steam-clean-install-execution.v1",
        jobDigest,
        signedJob: input.request.signedJob,
        testPlan: input.plan,
      }),
    });
    if (response.statusCode !== 200) throw new Error("Steam installed-game Connector rejected execution");
    const receipt = parseReceipt(response.payload, input.request.signedJob, jobDigest);
    const stagingRoot = await canonicalDirectory(this.#stagingRoot, this.#stagingRoot);
    const installRoot = await canonicalDirectory(receipt.installRoot, stagingRoot);
    const appManifestPath = await canonicalFile(receipt.appManifestPath, stagingRoot, 2 * 1024 * 1024);
    if (createHash("sha256").update(await readFile(appManifestPath)).digest("hex") !== receipt.appManifestDigest) {
      throw new Error("Steam installed-game appmanifest digest is invalid");
    }
    const harnessRoot = await canonicalDirectory(receipt.harnessRoot, stagingRoot);
    const harnessResultPath = await canonicalFile(receipt.harnessResultPath, harnessRoot, MAX_RESULT_BYTES);
    const logsPath = await canonicalFile(receipt.logsPath, harnessRoot, MAX_LOG_BYTES);
    const harness = parseGodotHarnessResult(
      JSON.parse(await readFile(harnessResultPath, "utf8")) as unknown,
      input.plan,
    );
    await verifyHarnessFiles(harnessRoot, harness);
    const logs = await readFile(logsPath, "utf8");
    if (/config\.vdf|steam.?guard|branch.?password|account.?password/i.test(logs)) {
      throw new Error("Steam installed-game Connector log contains forbidden credential material");
    }
    return Object.freeze({
      commands: receipt.commands,
      harness,
      exportRoot: installRoot,
      logs: `${logs.endsWith("\n") ? logs : `${logs}\n`}[steam-install-receipt] ${receipt.receiptDigest}\n`,
    });
  }

  async probe(): Promise<void> {
    const response = await this.#http({
      url: new URL("/healthz", this.#endpoint),
      method: "GET",
      tls: this.#tls,
      timeoutMs: Math.min(this.#timeoutMs, 30_000),
      body: "",
    });
    const body = record(response.payload);
    exactKeys(body, [
      "schemaVersion", "status", "service", "runnerId", "platform", "version", "bridgeVersion",
      "controllerContractVersion", "binaryDigest", "automationPolicyDigest", "supplyChainEvidenceDigest",
    ]);
    if (response.statusCode !== 200
      || body.schemaVersion !== "deviludo.steam-client-connector-health.v2"
      || body.status !== "ok" || body.service !== "deviludo-steam-client-connector"
      || body.runnerId !== this.#expectedConnector.runnerId
      || body.platform !== this.#expectedConnector.platform
      || body.version !== this.#expectedConnector.version
      || body.bridgeVersion !== this.#expectedConnector.bridgeVersion
      || body.controllerContractVersion !== this.#expectedConnector.controllerContractVersion
      || body.binaryDigest !== this.#expectedConnector.binaryDigest
      || body.automationPolicyDigest !== this.#expectedConnector.automationPolicyDigest
      || body.supplyChainEvidenceDigest !== this.#expectedConnector.supplyChainEvidenceDigest) {
      throw new Error("Steam installed-game Connector is not ready");
    }
  }
}

export async function steamInstalledGameDriverFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsSteamInstalledGameDriver> {
  const controlled = testKitSteamProcessEnvironmentFromEnv(env);
  const [key, certificate, ca, stagingRoot] = await Promise.all([
    readTlsFile(controlled.DEVILUDO_TESTKIT_STEAM_TLS_KEY_FILE!),
    readTlsFile(controlled.DEVILUDO_TESTKIT_STEAM_TLS_CERT_FILE!),
    readTlsFile(controlled.DEVILUDO_TESTKIT_STEAM_CA_FILE!),
    realpath(controlled.DEVILUDO_TESTKIT_STEAM_STAGING_ROOT!),
  ]);
  return new MtlsSteamInstalledGameDriver({
    endpoint: controlled.DEVILUDO_TESTKIT_STEAM_CONNECTOR_URL!,
    tls: { key, certificate, ca },
    stagingRoot,
    expectedConnector: {
      runnerId: controlled.DEVILUDO_TESTKIT_STEAM_CONNECTOR_RUNNER_ID!,
      platform: controlled.DEVILUDO_TESTKIT_STEAM_CONNECTOR_PLATFORM! as SteamInstalledGameConnectorIdentity["platform"],
      version: controlled.DEVILUDO_TESTKIT_STEAM_CONNECTOR_VERSION!,
      bridgeVersion: controlled.DEVILUDO_TESTKIT_STEAM_BRIDGE_VERSION!,
      controllerContractVersion: Number(controlled.DEVILUDO_TESTKIT_STEAM_CONTROLLER_CONTRACT_VERSION) as 1,
      binaryDigest: controlled.DEVILUDO_TESTKIT_STEAM_CONNECTOR_BINARY_DIGEST!,
      automationPolicyDigest: controlled.DEVILUDO_TESTKIT_STEAM_AUTOMATION_POLICY_DIGEST!,
      supplyChainEvidenceDigest: controlled.DEVILUDO_TESTKIT_STEAM_SUPPLY_CHAIN_EVIDENCE_DIGEST!,
    },
    timeoutMs: seconds(controlled.DEVILUDO_TESTKIT_STEAM_TIMEOUT_SECONDS, 3_000, 30, 3_600) * 1_000,
  });
}

/** Returns the only Steam Connector values allowed in the locked TestKit child. */
export function testKitSteamProcessEnvironmentFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    DEVILUDO_TESTKIT_STEAM_CONNECTOR_URL: strictOrigin(required(env, "DEVILUDO_TESTKIT_STEAM_CONNECTOR_URL")).origin,
    DEVILUDO_TESTKIT_STEAM_CONNECTOR_RUNNER_ID: runnerId(required(env, "DEVILUDO_TESTKIT_STEAM_CONNECTOR_RUNNER_ID")),
    DEVILUDO_TESTKIT_STEAM_CONNECTOR_PLATFORM: platform(required(env, "DEVILUDO_TESTKIT_STEAM_CONNECTOR_PLATFORM")),
    DEVILUDO_TESTKIT_STEAM_CONNECTOR_VERSION: fixedVersion(required(env, "DEVILUDO_TESTKIT_STEAM_CONNECTOR_VERSION")),
    DEVILUDO_TESTKIT_STEAM_BRIDGE_VERSION: fixedVersion(required(env, "DEVILUDO_TESTKIT_STEAM_BRIDGE_VERSION")),
    DEVILUDO_TESTKIT_STEAM_CONTROLLER_CONTRACT_VERSION: contractVersion(required(env, "DEVILUDO_TESTKIT_STEAM_CONTROLLER_CONTRACT_VERSION")),
    DEVILUDO_TESTKIT_STEAM_CONNECTOR_BINARY_DIGEST: requiredDigest(required(env, "DEVILUDO_TESTKIT_STEAM_CONNECTOR_BINARY_DIGEST")),
    DEVILUDO_TESTKIT_STEAM_AUTOMATION_POLICY_DIGEST: requiredDigest(required(env, "DEVILUDO_TESTKIT_STEAM_AUTOMATION_POLICY_DIGEST")),
    DEVILUDO_TESTKIT_STEAM_SUPPLY_CHAIN_EVIDENCE_DIGEST: requiredDigest(required(env, "DEVILUDO_TESTKIT_STEAM_SUPPLY_CHAIN_EVIDENCE_DIGEST")),
    DEVILUDO_TESTKIT_STEAM_TLS_KEY_FILE: absolutePath(required(env, "DEVILUDO_TESTKIT_STEAM_TLS_KEY_FILE"), "Steam TLS key"),
    DEVILUDO_TESTKIT_STEAM_TLS_CERT_FILE: absolutePath(required(env, "DEVILUDO_TESTKIT_STEAM_TLS_CERT_FILE"), "Steam TLS certificate"),
    DEVILUDO_TESTKIT_STEAM_CA_FILE: absolutePath(required(env, "DEVILUDO_TESTKIT_STEAM_CA_FILE"), "Steam CA"),
    DEVILUDO_TESTKIT_STEAM_STAGING_ROOT: absolutePath(required(env, "DEVILUDO_TESTKIT_STEAM_STAGING_ROOT"), "Steam staging root"),
  };
  if (env.DEVILUDO_TESTKIT_STEAM_TIMEOUT_SECONDS !== undefined) {
    result.DEVILUDO_TESTKIT_STEAM_TIMEOUT_SECONDS = String(seconds(
      env.DEVILUDO_TESTKIT_STEAM_TIMEOUT_SECONDS, 3_000, 30, 3_600,
    ));
  }
  return Object.freeze(result);
}

export function steamInstalledGameConnectorHttpsJson(input: {
  readonly url: URL;
  readonly method: "GET" | "POST";
  readonly body: string;
  readonly tls: SteamInstalledGameConnectorTls;
  readonly timeoutMs: number;
}): Promise<Readonly<{ statusCode: number; payload: unknown }>> {
  return new Promise((resolve, reject) => {
    const headers = input.method === "POST" ? {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(input.body)),
      } : { accept: "application/json" };
    const options: RequestOptions = {
      method: input.method,
      headers,
      key: input.tls.key,
      cert: input.tls.certificate,
      ca: input.tls.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: input.url.hostname,
    };
    const request = httpsRequest(input.url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Steam installed-game Connector response exceeded the limit"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        try { resolve({ statusCode: response.statusCode ?? 503, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }); }
        catch { reject(new Error("Steam installed-game Connector returned invalid JSON")); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Steam installed-game Connector timed out")));
    request.once("error", reject);
    request.end(input.method === "POST" ? input.body : undefined);
  });
}

type Receipt = Readonly<{
  receiptDigest: string;
  installRoot: string;
  appManifestPath: string;
  appManifestDigest: string;
  harnessRoot: string;
  harnessResultPath: string;
  logsPath: string;
  commands: readonly GodotCommandEvidence[];
}>;

function parseReceipt(value: unknown, job: SignedRunnerJob, jobDigest: string): Receipt {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "receiptDigest", "jobDigest", "executionLockDigest", "platform", "steamAppId", "buildId",
    "betaBranch", "installGrantId", "cleanClient", "installRoot", "appManifestPath", "appManifestDigest",
    "harnessRoot", "harnessResultPath", "logsPath", "commands",
  ]);
  const execution = job.payload.execution;
  if (execution.kind !== "STEAM_CLEAN_INSTALL" || body.schemaVersion !== "deviludo.steam-clean-install-execution-receipt.v2"
    || body.jobDigest !== jobDigest || body.executionLockDigest !== job.payload.executionLockDigest
    || body.platform !== job.payload.platform || body.steamAppId !== execution.steamAppId
    || body.buildId !== execution.buildId || body.betaBranch !== execution.betaBranch
    || body.installGrantId !== execution.installGrantId || body.cleanClient !== true) invalidReceipt();
  const core = { ...body };
  delete core.receiptDigest;
  if (typeof body.receiptDigest !== "string" || !SHA256.test(body.receiptDigest)
    || sha256Canonical(core) !== body.receiptDigest) invalidReceipt();
  const commands = parseCommands(body.commands);
  return Object.freeze({
    receiptDigest: body.receiptDigest,
    installRoot: absoluteReceiptPath(body.installRoot),
    appManifestPath: absoluteReceiptPath(body.appManifestPath),
    appManifestDigest: requiredDigest(String(body.appManifestDigest)),
    harnessRoot: absoluteReceiptPath(body.harnessRoot),
    harnessResultPath: absoluteReceiptPath(body.harnessResultPath),
    logsPath: absoluteReceiptPath(body.logsPath),
    commands,
  });
}

function parseCommands(value: unknown): readonly GodotCommandEvidence[] {
  if (!Array.isArray(value) || value.length !== 4) invalidReceipt();
  const expected = ["steam-client-reset", "steam-install", "production-boot", "platform-suite"] as const;
  return Object.freeze(value.map((item, index) => {
    const body = record(item);
    exactKeys(body, ["id", "status", "durationMs", "code"]);
    if (body.id !== expected[index] || (body.status !== "PASSED" && body.status !== "FAILED")
      || !Number.isFinite(body.durationMs) || (body.durationMs as number) < 0 || (body.durationMs as number) > 3_600_000
      || typeof body.code !== "string" || !CODE.test(body.code)) invalidReceipt();
    return Object.freeze({
      id: body.id,
      status: body.status,
      durationMs: body.durationMs as number,
      code: body.code,
    }) as GodotCommandEvidence;
  }));
}

async function canonicalDirectory(path: string, root: string): Promise<string> {
  const requested = absoluteReceiptPath(path);
  const metadata = await lstat(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Steam installed-game directory is invalid");
  const canonical = await realpath(requested);
  const boundary = await realpath(root);
  if (canonical !== boundary && !canonical.startsWith(`${boundary}${sep}`)) throw new Error("Steam installed-game directory escaped staging root");
  return canonical;
}

async function canonicalFile(path: string, root: string, maximum: number): Promise<string> {
  const requested = absoluteReceiptPath(path);
  const metadata = await lstat(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maximum) {
    throw new Error("Steam installed-game output file is invalid");
  }
  const canonical = await realpath(requested);
  if (!canonical.startsWith(`${root}${sep}`)) throw new Error("Steam installed-game output escaped harness root");
  return canonical;
}

async function verifyHarnessFiles(root: string, result: ReturnType<typeof parseGodotHarnessResult>): Promise<void> {
  for (const screenshot of result.screenshots) {
    const path = await canonicalFile(resolve(root, ...screenshot.file.split("/")), root, 128 * 1024 * 1024);
    const observed = createHash("sha256").update(await readFile(path)).digest("hex");
    if (observed !== screenshot.sha256) throw new Error("Steam installed-game screenshot digest is invalid");
  }
  await canonicalFile(resolve(root, ...result.videoFile.split("/")), root, 4 * 1024 * 1024 * 1024);
}

async function readTlsFile(path: string): Promise<Buffer> {
  const value = await readFile(absolutePath(path, "Steam TLS file"));
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) throw new Error("Steam installed-game TLS file is invalid");
  return value;
}

function validateTls(value: SteamInstalledGameConnectorTls): void {
  if (!Buffer.isBuffer(value.key) || !Buffer.isBuffer(value.certificate) || !Buffer.isBuffer(value.ca)
    || value.key.byteLength < 32 || value.certificate.byteLength < 32 || value.ca.byteLength < 32) {
    throw new Error("Steam installed-game TLS material is invalid");
  }
}

function connectorIdentity(value: SteamInstalledGameConnectorIdentity): SteamInstalledGameConnectorIdentity {
  const body = record(value);
  exactKeys(body, ["runnerId", "platform", "version", "bridgeVersion", "controllerContractVersion",
    "binaryDigest", "automationPolicyDigest", "supplyChainEvidenceDigest"]);
  return Object.freeze({
    runnerId: runnerId(value.runnerId),
    platform: platform(value.platform),
    version: fixedVersion(value.version),
    bridgeVersion: fixedVersion(value.bridgeVersion),
    controllerContractVersion: Number(contractVersion(String(value.controllerContractVersion))) as 1,
    binaryDigest: requiredDigest(value.binaryDigest),
    automationPolicyDigest: requiredDigest(value.automationPolicyDigest),
    supplyChainEvidenceDigest: requiredDigest(value.supplyChainEvidenceDigest),
  });
}

function runnerId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(value)) throw new Error("Steam Connector Runner ID is invalid");
  return value;
}

function platform(value: string): SteamInstalledGameConnectorIdentity["platform"] {
  if (value !== "windows" && value !== "linux" && value !== "macos") throw new Error("Steam Connector platform is invalid");
  return value;
}

function fixedVersion(value: string): string {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/.test(value)
    || /(?:latest|stable|default)/i.test(value)) throw new Error("Steam Connector version is invalid");
  return value;
}

function contractVersion(value: string): string {
  if (value !== "1") throw new Error("Steam Connector controller contract version is invalid");
  return value;
}

function requiredDigest(value: string): string {
  if (!SHA256.test(value)) throw new Error("Steam Connector binary digest is invalid");
  return value;
}

function strictOrigin(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Steam installed-game Connector URL is invalid");
  return new URL(url.origin);
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    throw new Error(`${label} path is invalid`);
  }
  return value;
}

function absoluteReceiptPath(value: unknown): string {
  if (typeof value !== "string") invalidReceipt();
  return absolutePath(value, "Steam receipt");
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Steam installed-game timeout is invalid");
  }
  return parsed;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("Steam installed-game timeout is invalid");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidReceipt();
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalidReceipt();
}

function invalidReceipt(): never {
  throw new Error("Steam installed-game Connector receipt is invalid");
}
