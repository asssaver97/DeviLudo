import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { sha256Canonical } from "../../runner-control/src/canonical";
import { ServiceProblem, type AgentKind } from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SECRET_BYTES = 1024 * 1024;
const VALIDATION_FAILURES = new Set([
  "SIGNATURE_INVALID", "INTEGRITY_MISMATCH", "SBOM_INVALID", "MALWARE_DETECTED",
  "VULNERABILITY_POLICY_FAILED", "ADAPTER_CONTRACT_FAILED", "SANDBOX_POLICY_FAILED", "SYNTHETIC_TASK_FAILED",
]);
const BUILD_FAILURES = new Set([
  "SBOM_INVALID", "MALWARE_DETECTED", "VULNERABILITY_POLICY_FAILED", "ADAPTER_CONTRACT_FAILED",
  "SANDBOX_POLICY_FAILED", "SYNTHETIC_TASK_FAILED", "IMAGE_BUILD_FAILED",
]);
const ROLLOUT_FAILURES = new Set(["CANARY_HEALTH_FAILED", "DEPLOYMENT_HEALTH_FAILED"]);

export interface AgentVersionCandidateReceipt {
  readonly agent: AgentKind;
  readonly version: string;
  readonly source: string;
  readonly sourceDigest: string;
  readonly releaseNotesUrl: string;
  readonly catalogReceiptId: string;
  readonly catalogReceiptDigest: string;
  readonly discoveredAt: string;
}

export interface AgentVersionValidationReceipt {
  readonly agent: AgentKind;
  readonly version: string;
  readonly sourceDigest: string;
  readonly integrity: string;
  readonly signatureVerified: true;
  readonly sbomRef: string;
  readonly scan: "PASS";
  readonly supplyChainEvidenceDigest: string;
  readonly validationReceiptId: string;
  readonly validationReceiptDigest: string;
  readonly validatedAt: string;
}

export interface AgentInstallationBuildReceipt {
  readonly installationId: string;
  readonly agent: AgentKind;
  readonly version: string;
  readonly workerPool: string;
  readonly adapterVersion: string;
  readonly workerImageId: string;
  readonly imageDigest: string;
  readonly rollbackInstallationId: string | null;
  readonly stages: readonly ["BUILDING", "SCANNING", "SMOKE_TESTING", "READY"];
  readonly health: "HEALTHY";
  readonly selfUpdateDisabled: true;
  readonly buildReceiptId: string;
  readonly buildReceiptDigest: string;
  readonly completedAt: string;
}

export interface AgentInstallationRolloutReceipt {
  readonly installationId: string;
  readonly imageDigest: string;
  readonly action: "ADVANCE" | "ROLLBACK";
  readonly fromPercent: 0 | 5 | 25 | 100;
  readonly toPercent: 0 | 5 | 25 | 100;
  readonly state: "READY" | "CANARY" | "ACTIVE";
  readonly health: "HEALTHY";
  readonly newTasksOnly: true;
  readonly runningTasksUnaffected: true;
  readonly rolloutReceiptId: string;
  readonly rolloutReceiptDigest: string;
  readonly completedAt: string;
}

export type AgentSupplyChainFailureCode =
  | "SIGNATURE_INVALID"
  | "INTEGRITY_MISMATCH"
  | "SBOM_INVALID"
  | "MALWARE_DETECTED"
  | "VULNERABILITY_POLICY_FAILED"
  | "ADAPTER_CONTRACT_FAILED"
  | "SANDBOX_POLICY_FAILED"
  | "SYNTHETIC_TASK_FAILED"
  | "IMAGE_BUILD_FAILED"
  | "CANARY_HEALTH_FAILED"
  | "DEPLOYMENT_HEALTH_FAILED";

export interface AgentSupplyChainTerminalFailureReceipt {
  readonly schemaVersion: "deviludo.agent-supply-chain-terminal-failure.v1";
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly operationKind: "VALIDATE" | "BUILD" | "ROLLOUT";
  readonly disposition: "REJECTED" | "QUARANTINED";
  readonly failureCode: AgentSupplyChainFailureCode;
  readonly evidenceDigest: string;
  readonly failureReceiptId: string;
  readonly failedAt: string;
  readonly failureReceiptDigest: string;
}

export class AgentSupplyChainPolicyFailure extends ServiceProblem {
  constructor(readonly receipt: AgentSupplyChainTerminalFailureReceipt) {
    super(422, "AGENT_SUPPLY_CHAIN_POLICY_REJECTED", "Agent supply-chain policy rejected the operation", Object.freeze({
      disposition: receipt.disposition,
      failureCode: receipt.failureCode,
      evidenceDigest: receipt.evidenceDigest,
      failureReceiptId: receipt.failureReceiptId,
      failureReceiptDigest: receipt.failureReceiptDigest,
      failedAt: receipt.failedAt,
    }));
    this.name = "AgentSupplyChainPolicyFailure";
  }
}

export interface AgentSupplyChainHealth {
  readonly service: "deviludo-agent-supply-chain";
  readonly version: string;
  readonly binaryDigest: string;
  readonly status: "READY";
  readonly checkedAt: string;
}

export type AgentSupplyChainOperation = Readonly<{ operationKey: string; requestDigest: string }>;

export abstract class AgentSupplyChain {
  abstract discover(input: AgentSupplyChainOperation & Readonly<{
    agent: AgentKind;
    requestedVersion: string | null;
  }>): Promise<readonly AgentVersionCandidateReceipt[]>;
  abstract validateVersion(input: AgentSupplyChainOperation & Readonly<{
    candidate: AgentVersionCandidateReceipt;
  }>): Promise<AgentVersionValidationReceipt>;
  abstract buildInstallation(input: AgentSupplyChainOperation & Readonly<{
    installationId: string;
    candidate: AgentVersionCandidateReceipt;
    validation: AgentVersionValidationReceipt;
    workerPool: string;
    adapterVersion: string;
    rollbackInstallationId: string | null;
  }>): Promise<AgentInstallationBuildReceipt>;
  abstract rollout(input: AgentSupplyChainOperation & Readonly<{
    installationId: string;
    imageDigest: string;
    action: "ADVANCE" | "ROLLBACK";
    fromPercent: 0 | 5 | 25 | 100;
    toPercent: 0 | 5 | 25 | 100;
  }>): Promise<AgentInstallationRolloutReceipt>;
  abstract probe(): Promise<AgentSupplyChainHealth>;
}

/** Deterministic local implementation; production never selects this class. */
export class DevelopmentAgentSupplyChain extends AgentSupplyChain {
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) { super(); this.#now = now; }

  async discover(input: Parameters<AgentSupplyChain["discover"]>[0]) {
    validateOperation(input);
    const version = input.requestedVersion ?? (input.agent === "claude-code" ? "2.1.15" : "0.92.0");
    exactVersion(version);
    const discoveredAt = validDate(this.#now()).toISOString();
    const core = Object.freeze({
      agent: input.agent,
      version,
      source: input.agent === "claude-code"
        ? `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`
        : `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`,
      sourceDigest: sha256Canonical({ agent: input.agent, version, artifact: "official-package" }),
      releaseNotesUrl: input.agent === "claude-code"
        ? "https://github.com/anthropics/claude-code/releases"
        : "https://github.com/openai/codex/releases",
      catalogReceiptId: `catalog-${input.agent}-${version}`,
      discoveredAt,
    });
    return Object.freeze([Object.freeze({ ...core, catalogReceiptDigest: sha256Canonical(core) })]);
  }

  async validateVersion(input: Parameters<AgentSupplyChain["validateVersion"]>[0]) {
    validateOperation(input);
    const candidate = candidateReceipt(input.candidate);
    const validatedAt = validDate(this.#now()).toISOString();
    const evidenceDigest = sha256Canonical({ candidate, gates: [
      "official-signature", "package-integrity", "sbom", "malware", "vulnerability", "adapter-contract", "sandbox", "synthetic-task",
    ] });
    const core = Object.freeze({
      agent: candidate.agent,
      version: candidate.version,
      sourceDigest: candidate.sourceDigest,
      integrity: `sha256:${sha256Canonical({ candidate, artifact: "mirrored-package" })}`,
      signatureVerified: true as const,
      sbomRef: `oci://registry.deviludo.local/sbom/${candidate.agent}@sha256:${evidenceDigest}`,
      scan: "PASS" as const,
      supplyChainEvidenceDigest: evidenceDigest,
      validationReceiptId: `validation-${candidate.agent}-${candidate.version}`,
      validatedAt,
    });
    return Object.freeze({ ...core, validationReceiptDigest: sha256Canonical(core) });
  }

  async buildInstallation(input: Parameters<AgentSupplyChain["buildInstallation"]>[0]) {
    validateOperation(input);
    const candidate = candidateReceipt(input.candidate);
    const validation = validationReceipt(input.validation, candidate);
    if (!SAFE_ID.test(input.installationId) || !workerPool(input.workerPool) || !VERSION.test(input.adapterVersion)
      || (input.rollbackInstallationId !== null && !SAFE_ID.test(input.rollbackInstallationId))) invalidReceipt();
    const completedAt = validDate(this.#now()).toISOString();
    const imageHash = sha256Canonical({ candidate, validation, workerPool: input.workerPool, adapterVersion: input.adapterVersion });
    const core = Object.freeze({
      installationId: input.installationId,
      agent: candidate.agent,
      version: candidate.version,
      workerPool: input.workerPool,
      adapterVersion: input.adapterVersion,
      workerImageId: `worker-image-${imageHash.slice(0, 32)}`,
      imageDigest: `sha256:${imageHash}`,
      rollbackInstallationId: input.rollbackInstallationId,
      stages: Object.freeze(["BUILDING", "SCANNING", "SMOKE_TESTING", "READY"] as const),
      health: "HEALTHY" as const,
      selfUpdateDisabled: true as const,
      buildReceiptId: `build-${input.installationId}`,
      completedAt,
    });
    return Object.freeze({ ...core, buildReceiptDigest: sha256Canonical(core) });
  }

  async rollout(input: Parameters<AgentSupplyChain["rollout"]>[0]) {
    validateOperation(input);
    if (!SAFE_ID.test(input.installationId) || !DIGEST.test(input.imageDigest)) invalidReceipt();
    validateRollout(input.action, input.fromPercent, input.toPercent);
    const completedAt = validDate(this.#now()).toISOString();
    const core = Object.freeze({
      installationId: input.installationId,
      imageDigest: input.imageDigest,
      action: input.action,
      fromPercent: input.fromPercent,
      toPercent: input.toPercent,
      state: (input.toPercent === 0 ? "READY" : input.toPercent === 100 ? "ACTIVE" : "CANARY") as "READY" | "CANARY" | "ACTIVE",
      health: "HEALTHY" as const,
      newTasksOnly: true as const,
      runningTasksUnaffected: true as const,
      rolloutReceiptId: `rollout-${input.installationId}-${input.action.toLowerCase()}-${input.toPercent}`,
      completedAt,
    });
    return Object.freeze({ ...core, rolloutReceiptDigest: sha256Canonical(core) });
  }

  async probe(): Promise<AgentSupplyChainHealth> {
    return Object.freeze({
      service: "deviludo-agent-supply-chain",
      version: "0.1.0-local",
      binaryDigest: sha256Canonical({ service: "deviludo-agent-supply-chain", mode: "development" }),
      status: "READY",
      checkedAt: validDate(this.#now()).toISOString(),
    });
  }
}

export interface AgentSupplyChainHttpResponse { readonly statusCode: number; readonly payload: unknown }
export type AgentSupplyChainHttp = (input: Readonly<{
  url: URL;
  body: string;
  tls: AgentSupplyChainTls;
  timeoutMs: number;
}>) => Promise<AgentSupplyChainHttpResponse>;
export interface AgentSupplyChainTls { readonly key: Buffer; readonly certificate: Buffer; readonly ca: Buffer }

/** mTLS client for the isolated OCI builder/scanner/deployer service. */
export class MtlsAgentSupplyChain extends AgentSupplyChain {
  readonly #endpoint: URL;
  readonly #tls: AgentSupplyChainTls;
  readonly #version: string;
  readonly #binaryDigest: string;
  readonly #timeoutMs: number;
  readonly #http: AgentSupplyChainHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: AgentSupplyChainTls;
    version: string;
    binaryDigest: string;
    timeoutMs?: number;
    http?: AgentSupplyChainHttp;
  }>) {
    super();
    this.#endpoint = strictOrigin(options.endpoint);
    tls(options.tls);
    exactVersion(options.version);
    if (!SHA256.test(options.binaryDigest)) invalidConfig();
    this.#tls = Object.freeze({ key: Buffer.from(options.tls.key), certificate: Buffer.from(options.tls.certificate), ca: Buffer.from(options.tls.ca) });
    this.#version = options.version;
    this.#binaryDigest = options.binaryDigest;
    this.#timeoutMs = integer(options.timeoutMs ?? 60_000, 1_000, 10 * 60_000);
    this.#http = options.http ?? agentSupplyChainHttpsJson;
  }

  async discover(input: Parameters<AgentSupplyChain["discover"]>[0]) {
    validateOperation(input);
    const payload = await this.#post("/v1/agent-versions/discover", {
      schemaVersion: "deviludo.agent-version-discovery-request.v1", ...input,
    });
    const body = record(payload);
    exactKeys(body, ["schemaVersion", "candidates"]);
    if (body.schemaVersion !== "deviludo.agent-version-discovery-receipt.v1" || !Array.isArray(body.candidates)
      || body.candidates.length < 1 || body.candidates.length > 20) invalidReceipt();
    const candidates = body.candidates.map(candidateReceipt);
    if (candidates.some((candidate) => candidate.agent !== input.agent
      || (input.requestedVersion !== null && candidate.version !== input.requestedVersion))) invalidReceipt();
    return Object.freeze(candidates);
  }

  async validateVersion(input: Parameters<AgentSupplyChain["validateVersion"]>[0]) {
    validateOperation(input);
    const candidate = candidateReceipt(input.candidate);
    return validationReceipt(await this.#post("/v1/agent-versions/validate", {
      schemaVersion: "deviludo.agent-version-validation-request.v1", ...input, candidate,
    }), candidate);
  }

  async buildInstallation(input: Parameters<AgentSupplyChain["buildInstallation"]>[0]) {
    validateOperation(input);
    const candidate = candidateReceipt(input.candidate);
    const validation = validationReceipt(input.validation, candidate);
    return buildReceipt(await this.#post("/v1/agent-installations/build", {
      schemaVersion: "deviludo.agent-installation-build-request.v1", ...input, candidate, validation,
    }), input);
  }

  async rollout(input: Parameters<AgentSupplyChain["rollout"]>[0]) {
    validateOperation(input);
    validateRollout(input.action, input.fromPercent, input.toPercent);
    return rolloutReceipt(await this.#post("/v1/agent-installations/rollout", {
      schemaVersion: "deviludo.agent-installation-rollout-request.v1", ...input,
    }), input);
  }

  async probe(): Promise<AgentSupplyChainHealth> {
    const payload = await this.#post("/healthz", { schemaVersion: "deviludo.agent-supply-chain-health-request.v1" });
    const body = record(payload);
    exactKeys(body, ["schemaVersion", "service", "version", "binaryDigest", "status", "checkedAt"]);
    if (body.schemaVersion !== "deviludo.agent-supply-chain-health.v1" || body.service !== "deviludo-agent-supply-chain"
      || body.version !== this.#version || body.binaryDigest !== this.#binaryDigest || body.status !== "READY"
      || typeof body.checkedAt !== "string" || !Number.isFinite(Date.parse(body.checkedAt))) invalidReceipt();
    return Object.freeze({
      service: "deviludo-agent-supply-chain", version: body.version, binaryDigest: body.binaryDigest,
      status: "READY", checkedAt: body.checkedAt,
    });
  }

  async #post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const url = new URL(this.#endpoint.href); url.pathname = path;
    const response = await this.#http({ url, body: JSON.stringify(body), tls: this.#tls, timeoutMs: this.#timeoutMs });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (response.statusCode === 422) throw new AgentSupplyChainPolicyFailure(policyFailureReceipt(response.payload, body));
      throw new ServiceProblem(response.statusCode === 409 ? 409 : 503, "AGENT_SUPPLY_CHAIN_REJECTED", "Agent supply-chain Broker rejected the operation");
    }
    return response.payload;
  }
}

export async function createAgentSupplyChain(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AgentSupplyChain> {
  if (env.NODE_ENV !== "production") return new DevelopmentAgentSupplyChain();
  const [key, certificate, ca] = await Promise.all([
    secret(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_CA_FILE"),
  ]);
  return new MtlsAgentSupplyChain({
    endpoint: required(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_URL"),
    tls: { key, certificate, ca },
    version: required(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_VERSION"),
    binaryDigest: required(env, "DEVILUDO_AGENT_SUPPLY_CHAIN_BINARY_DIGEST"),
    timeoutMs: seconds(env.DEVILUDO_AGENT_SUPPLY_CHAIN_TIMEOUT_SECONDS, 60) * 1_000,
  });
}

export function agentSupplyChainHttpsJson(input: Parameters<AgentSupplyChainHttp>[0]): Promise<AgentSupplyChainHttpResponse> {
  return new Promise((accept, reject) => {
    const options: RequestOptions = {
      method: "POST",
      key: input.tls.key,
      cert: input.tls.certificate,
      ca: input.tls.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: input.url.hostname,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(input.body), "accept": "application/json" },
    };
    const request = httpsRequest(input.url, options, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new Error("Agent supply-chain response is too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          accept(Object.freeze({ statusCode: response.statusCode ?? 0, payload: raw ? JSON.parse(raw) as unknown : null }));
        } catch { reject(new Error("Agent supply-chain response is invalid")); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Agent supply-chain request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function candidateReceipt(value: unknown): AgentVersionCandidateReceipt {
  const body = record(value);
  exactKeys(body, ["agent", "version", "source", "sourceDigest", "releaseNotesUrl", "catalogReceiptId", "catalogReceiptDigest", "discoveredAt"]);
  if (!agent(body.agent) || typeof body.version !== "string" || !VERSION.test(body.version)
    || typeof body.source !== "string" || !strictHttpsUrl(body.source)
    || typeof body.sourceDigest !== "string" || !SHA256.test(body.sourceDigest)
    || typeof body.releaseNotesUrl !== "string" || !strictHttpsUrl(body.releaseNotesUrl)
    || typeof body.catalogReceiptId !== "string" || !SAFE_ID.test(body.catalogReceiptId)
    || typeof body.catalogReceiptDigest !== "string" || !SHA256.test(body.catalogReceiptDigest)
    || typeof body.discoveredAt !== "string" || !Number.isFinite(Date.parse(body.discoveredAt))) invalidReceipt();
  const core = { agent: body.agent, version: body.version, source: body.source, sourceDigest: body.sourceDigest,
    releaseNotesUrl: body.releaseNotesUrl, catalogReceiptId: body.catalogReceiptId, discoveredAt: body.discoveredAt };
  if (sha256Canonical(core) !== body.catalogReceiptDigest) invalidReceipt();
  return Object.freeze({ ...core, catalogReceiptDigest: body.catalogReceiptDigest });
}

function validationReceipt(value: unknown, candidate: AgentVersionCandidateReceipt): AgentVersionValidationReceipt {
  const body = record(value);
  exactKeys(body, ["agent", "version", "sourceDigest", "integrity", "signatureVerified", "sbomRef", "scan",
    "supplyChainEvidenceDigest", "validationReceiptId", "validationReceiptDigest", "validatedAt"]);
  if (body.agent !== candidate.agent || body.version !== candidate.version || body.sourceDigest !== candidate.sourceDigest
    || typeof body.integrity !== "string" || !DIGEST.test(body.integrity) || body.signatureVerified !== true
    || typeof body.sbomRef !== "string" || !/^oci:\/\/[A-Za-z0-9][A-Za-z0-9._:/@-]{4,1000}$/.test(body.sbomRef)
    || body.scan !== "PASS" || typeof body.supplyChainEvidenceDigest !== "string" || !SHA256.test(body.supplyChainEvidenceDigest)
    || typeof body.validationReceiptId !== "string" || !SAFE_ID.test(body.validationReceiptId)
    || typeof body.validationReceiptDigest !== "string" || !SHA256.test(body.validationReceiptDigest)
    || typeof body.validatedAt !== "string" || !Number.isFinite(Date.parse(body.validatedAt))) invalidReceipt();
  const core = { agent: candidate.agent, version: candidate.version, sourceDigest: candidate.sourceDigest, integrity: body.integrity,
    signatureVerified: true as const, sbomRef: body.sbomRef, scan: "PASS" as const,
    supplyChainEvidenceDigest: body.supplyChainEvidenceDigest, validationReceiptId: body.validationReceiptId,
    validatedAt: body.validatedAt };
  if (sha256Canonical(core) !== body.validationReceiptDigest) invalidReceipt();
  return Object.freeze({ ...core, validationReceiptDigest: body.validationReceiptDigest });
}

function buildReceipt(value: unknown, input: Parameters<AgentSupplyChain["buildInstallation"]>[0]): AgentInstallationBuildReceipt {
  const body = record(value);
  exactKeys(body, ["installationId", "agent", "version", "workerPool", "adapterVersion", "workerImageId", "imageDigest",
    "rollbackInstallationId", "stages", "health", "selfUpdateDisabled", "buildReceiptId", "buildReceiptDigest", "completedAt"]);
  const expectedStages = ["BUILDING", "SCANNING", "SMOKE_TESTING", "READY"];
  if (body.installationId !== input.installationId || body.agent !== input.candidate.agent || body.version !== input.candidate.version
    || body.workerPool !== input.workerPool || body.adapterVersion !== input.adapterVersion
    || typeof body.workerImageId !== "string" || !SAFE_ID.test(body.workerImageId)
    || typeof body.imageDigest !== "string" || !DIGEST.test(body.imageDigest)
    || body.rollbackInstallationId !== input.rollbackInstallationId || JSON.stringify(body.stages) !== JSON.stringify(expectedStages)
    || body.health !== "HEALTHY" || body.selfUpdateDisabled !== true
    || typeof body.buildReceiptId !== "string" || !SAFE_ID.test(body.buildReceiptId)
    || typeof body.buildReceiptDigest !== "string" || !SHA256.test(body.buildReceiptDigest)
    || typeof body.completedAt !== "string" || !Number.isFinite(Date.parse(body.completedAt))) invalidReceipt();
  const core = { installationId: body.installationId, agent: body.agent, version: body.version, workerPool: body.workerPool,
    adapterVersion: body.adapterVersion, workerImageId: body.workerImageId, imageDigest: body.imageDigest,
    rollbackInstallationId: body.rollbackInstallationId, stages: expectedStages, health: "HEALTHY", selfUpdateDisabled: true,
    buildReceiptId: body.buildReceiptId, completedAt: body.completedAt };
  if (sha256Canonical(core) !== body.buildReceiptDigest) invalidReceipt();
  return Object.freeze({ ...core, stages: Object.freeze(expectedStages) as AgentInstallationBuildReceipt["stages"],
    health: "HEALTHY", selfUpdateDisabled: true, buildReceiptDigest: body.buildReceiptDigest }) as AgentInstallationBuildReceipt;
}

function rolloutReceipt(value: unknown, input: Parameters<AgentSupplyChain["rollout"]>[0]): AgentInstallationRolloutReceipt {
  const body = record(value);
  exactKeys(body, ["installationId", "imageDigest", "action", "fromPercent", "toPercent", "state", "health",
    "newTasksOnly", "runningTasksUnaffected", "rolloutReceiptId", "rolloutReceiptDigest", "completedAt"]);
  const state = input.toPercent === 0 ? "READY" : input.toPercent === 100 ? "ACTIVE" : "CANARY";
  if (body.installationId !== input.installationId || body.imageDigest !== input.imageDigest || body.action !== input.action
    || body.fromPercent !== input.fromPercent || body.toPercent !== input.toPercent || body.state !== state
    || body.health !== "HEALTHY" || body.newTasksOnly !== true || body.runningTasksUnaffected !== true
    || typeof body.rolloutReceiptId !== "string" || !SAFE_ID.test(body.rolloutReceiptId)
    || typeof body.rolloutReceiptDigest !== "string" || !SHA256.test(body.rolloutReceiptDigest)
    || typeof body.completedAt !== "string" || !Number.isFinite(Date.parse(body.completedAt))) invalidReceipt();
  const core = { installationId: body.installationId, imageDigest: body.imageDigest, action: body.action,
    fromPercent: body.fromPercent, toPercent: body.toPercent, state: body.state, health: "HEALTHY",
    newTasksOnly: true, runningTasksUnaffected: true, rolloutReceiptId: body.rolloutReceiptId, completedAt: body.completedAt };
  if (sha256Canonical(core) !== body.rolloutReceiptDigest) invalidReceipt();
  return Object.freeze({ ...core, rolloutReceiptDigest: body.rolloutReceiptDigest }) as AgentInstallationRolloutReceipt;
}

function policyFailureReceipt(
  value: unknown,
  request: Readonly<Record<string, unknown>>,
): AgentSupplyChainTerminalFailureReceipt {
  const envelope = record(value);
  exactKeys(envelope, ["error"]);
  const error = record(envelope.error);
  exactKeys(error, ["code", "failure"]);
  if (error.code !== "AGENT_SUPPLY_CHAIN_POLICY_REJECTED") invalidReceipt();
  const body = record(error.failure);
  exactKeys(body, [
    "schemaVersion", "operationKey", "requestDigest", "operationKind", "disposition", "failureCode",
    "evidenceDigest", "failureReceiptId", "failedAt", "failureReceiptDigest",
  ]);
  const operationKind = failureOperationKind(request.schemaVersion);
  if (body.schemaVersion !== "deviludo.agent-supply-chain-terminal-failure.v1"
    || body.operationKey !== request.operationKey || body.requestDigest !== request.requestDigest
    || body.operationKind !== operationKind
    || body.disposition !== (operationKind === "VALIDATE" ? "REJECTED" : "QUARANTINED")
    || typeof body.failureCode !== "string" || !failureCodeAllowed(operationKind, body.failureCode)
    || typeof body.evidenceDigest !== "string" || !SHA256.test(body.evidenceDigest)
    || typeof body.failureReceiptId !== "string" || !SAFE_ID.test(body.failureReceiptId)
    || typeof body.failedAt !== "string" || !Number.isFinite(Date.parse(body.failedAt))
    || typeof body.failureReceiptDigest !== "string" || !SHA256.test(body.failureReceiptDigest)) invalidReceipt();
  const core = Object.freeze({
    schemaVersion: body.schemaVersion,
    operationKey: body.operationKey,
    requestDigest: body.requestDigest,
    operationKind: body.operationKind,
    disposition: body.disposition,
    failureCode: body.failureCode,
    evidenceDigest: body.evidenceDigest,
    failureReceiptId: body.failureReceiptId,
    failedAt: body.failedAt,
  });
  if (sha256Canonical(core) !== body.failureReceiptDigest) invalidReceipt();
  return Object.freeze({ ...core, failureReceiptDigest: body.failureReceiptDigest }) as AgentSupplyChainTerminalFailureReceipt;
}

function failureOperationKind(value: unknown): AgentSupplyChainTerminalFailureReceipt["operationKind"] {
  if (value === "deviludo.agent-version-validation-request.v1") return "VALIDATE";
  if (value === "deviludo.agent-installation-build-request.v1") return "BUILD";
  if (value === "deviludo.agent-installation-rollout-request.v1") return "ROLLOUT";
  invalidReceipt();
}

function failureCodeAllowed(kind: AgentSupplyChainTerminalFailureReceipt["operationKind"], code: string): boolean {
  return (kind === "VALIDATE" ? VALIDATION_FAILURES : kind === "BUILD" ? BUILD_FAILURES : ROLLOUT_FAILURES).has(code);
}

function validateOperation(input: AgentSupplyChainOperation): void {
  if (!SHA256.test(input.operationKey) || !SHA256.test(input.requestDigest)) invalidReceipt();
}
function validateRollout(action: string, from: number, to: number): void {
  const valid = action === "ROLLBACK" ? to === 0 && from !== 0
    : action === "ADVANCE" && ((from === 0 && to === 5) || (from === 5 && to === 25) || (from === 25 && to === 100));
  if (!valid) invalidReceipt();
}
function agent(value: unknown): value is AgentKind { return value === "claude-code" || value === "codex-cli"; }
function workerPool(value: string): boolean { return /^dev(?:elopment)?[-_a-z0-9]{0,100}$/i.test(value); }
function exactVersion(value: string): void { if (!VERSION.test(value) || /latest|stable|default/i.test(value)) invalidConfig(); }
function strictHttpsUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }
function strictOrigin(value: string | URL): URL { const url = new URL(value); if (!strictHttpsUrl(url.href) || url.search || (url.pathname !== "/" && url.pathname !== "")) invalidConfig(); return url; }
function tls(value: AgentSupplyChainTls): void { if (![value.key, value.certificate, value.ca].every((item) => Buffer.isBuffer(item) && item.byteLength >= 32 && item.byteLength <= MAX_SECRET_BYTES)) invalidConfig(); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalidReceipt(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const left = Object.keys(value).sort(); const right = [...expected].sort(); if (left.length !== right.length || left.some((key, index) => key !== right[index])) invalidReceipt(); }
function validDate(value: Date): Date { if (!Number.isFinite(value.getTime())) invalidConfig(); return value; }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isInteger(value) || value < minimum || value > maximum) invalidConfig(); return value; }
function seconds(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600 || String(parsed) !== value) invalidConfig(); return parsed; }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = required(env, name); if (!isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /\0/.test(value)) throw new Error(`${name} path is invalid`); return value; }
async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> { const file = await open(absolute(env, name), constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await file.stat(); if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`); return await file.readFile(); } finally { await file.close(); } }
function invalidConfig(): never { throw new Error("Agent supply-chain configuration is invalid"); }
function invalidReceipt(): never { throw new ServiceProblem(502, "AGENT_SUPPLY_CHAIN_RECEIPT_INVALID", "Agent supply-chain receipt is invalid"); }

export function parseAgentVersionCandidateReceipt(value: unknown): AgentVersionCandidateReceipt {
  return candidateReceipt(value);
}

export function parseAgentVersionValidationReceipt(
  value: unknown,
  candidate: AgentVersionCandidateReceipt,
): AgentVersionValidationReceipt {
  return validationReceipt(value, candidate);
}

export function parseAgentInstallationBuildReceipt(
  value: unknown,
  input: Parameters<AgentSupplyChain["buildInstallation"]>[0],
): AgentInstallationBuildReceipt {
  return buildReceipt(value, input);
}

export function parseAgentInstallationRolloutReceipt(
  value: unknown,
  input: Parameters<AgentSupplyChain["rollout"]>[0],
): AgentInstallationRolloutReceipt {
  return rolloutReceipt(value, input);
}
