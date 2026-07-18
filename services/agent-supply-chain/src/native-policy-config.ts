import { isAbsolute, resolve } from "node:path";
import type { AgentKind } from "../../control-plane/src/contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const NPM_KEY_ID = /^SHA256:[A-Za-z0-9+/_=-]{20,240}$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const OCI_DIGEST_REF = /^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?\/[a-z0-9/._-]+@sha256:[a-f0-9]{64}$/;
const KMS_REF = /^kms:\/\/[A-Za-z0-9][A-Za-z0-9._~:/?=&%-]{2,1000}$/;

export const NATIVE_POLICY_TOOL_IDS = [
  "syft", "trivy", "clamscan", "oras", "buildctl", "cosign", "nerdctl", "fleetctl",
] as const;

export type NativePolicyToolId = (typeof NATIVE_POLICY_TOOL_IDS)[number];

export interface NativePolicyTool {
  readonly path: string;
  readonly digest: string;
  readonly version: string;
}

export interface NativePolicyAgent {
  readonly packageName: "@anthropic-ai/claude-code" | "@openai/codex";
  readonly workerBaseImage: string;
  readonly validationHarnessImage: string;
  readonly adapterVersion: string;
}

export interface NativePolicyWorkerPool {
  readonly id: string;
  readonly rolloutTarget: string;
}

export interface NativeAgentSupplyChainPolicy {
  readonly schemaVersion: "deviludo.agent-supply-chain-native-policy.v1";
  readonly policyVersion: string;
  readonly officialRegistryOrigin: "https://registry.npmjs.org";
  readonly trustedNpmKeyIds: readonly string[];
  readonly internalRegistryOrigin: string;
  readonly packageRepositoryPrefix: string;
  readonly imageRepositoryPrefix: string;
  readonly sbomRepositoryPrefix: string;
  readonly signingKeyRef: string;
  readonly registryConfigDirectory: string;
  readonly scannerDataDirectory: string;
  readonly fleetConfigFile: string;
  readonly maxPackageBytes: number;
  readonly maxExtractedBytes: number;
  readonly tools: Readonly<Record<NativePolicyToolId, NativePolicyTool>>;
  readonly agents: Readonly<Record<AgentKind, NativePolicyAgent>>;
  readonly workerPools: readonly NativePolicyWorkerPool[];
}

export function parseNativeAgentSupplyChainPolicy(value: unknown): NativeAgentSupplyChainPolicy {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "policyVersion", "officialRegistryOrigin", "trustedNpmKeyIds", "internalRegistryOrigin",
    "packageRepositoryPrefix", "imageRepositoryPrefix", "sbomRepositoryPrefix", "signingKeyRef",
    "registryConfigDirectory", "scannerDataDirectory", "fleetConfigFile", "maxPackageBytes", "maxExtractedBytes",
    "tools", "agents", "workerPools",
  ]);
  if (body.schemaVersion !== "deviludo.agent-supply-chain-native-policy.v1"
    || typeof body.policyVersion !== "string" || !exactVersion(body.policyVersion)
    || body.officialRegistryOrigin !== "https://registry.npmjs.org"
    || typeof body.internalRegistryOrigin !== "string"
    || strictOrigin(body.internalRegistryOrigin) !== body.internalRegistryOrigin
    || typeof body.packageRepositoryPrefix !== "string" || !REPOSITORY.test(body.packageRepositoryPrefix)
    || typeof body.imageRepositoryPrefix !== "string" || !REPOSITORY.test(body.imageRepositoryPrefix)
    || typeof body.sbomRepositoryPrefix !== "string" || !REPOSITORY.test(body.sbomRepositoryPrefix)
    || typeof body.signingKeyRef !== "string" || !KMS_REF.test(body.signingKeyRef)
    || typeof body.registryConfigDirectory !== "string" || !absolute(body.registryConfigDirectory)
    || typeof body.scannerDataDirectory !== "string" || !absolute(body.scannerDataDirectory)
    || typeof body.fleetConfigFile !== "string" || !absolute(body.fleetConfigFile)) invalid();
  const trustedNpmKeyIds = stringSet(body.trustedNpmKeyIds, "npm key", 1, 32, NPM_KEY_ID);
  const tools = toolSet(body.tools);
  const agents = agentSet(body.agents);
  const workerPools = poolSet(body.workerPools);
  return Object.freeze({
    schemaVersion: body.schemaVersion,
    policyVersion: body.policyVersion,
    officialRegistryOrigin: body.officialRegistryOrigin,
    trustedNpmKeyIds,
    internalRegistryOrigin: body.internalRegistryOrigin,
    packageRepositoryPrefix: body.packageRepositoryPrefix,
    imageRepositoryPrefix: body.imageRepositoryPrefix,
    sbomRepositoryPrefix: body.sbomRepositoryPrefix,
    signingKeyRef: body.signingKeyRef,
    registryConfigDirectory: body.registryConfigDirectory,
    scannerDataDirectory: body.scannerDataDirectory,
    fleetConfigFile: body.fleetConfigFile,
    maxPackageBytes: integer(body.maxPackageBytes, 1024 * 1024, 512 * 1024 * 1024),
    maxExtractedBytes: integer(body.maxExtractedBytes, 1024 * 1024, 2 * 1024 * 1024 * 1024),
    tools,
    agents,
    workerPools,
  });
}

export function nativePolicyAgent(
  policy: NativeAgentSupplyChainPolicy,
  agent: AgentKind,
): NativePolicyAgent {
  return policy.agents[agent];
}

export function nativePolicyWorkerPool(
  policy: NativeAgentSupplyChainPolicy,
  id: string,
): NativePolicyWorkerPool {
  const pool = policy.workerPools.find((candidate) => candidate.id === id);
  if (!pool) invalid();
  return pool;
}

function toolSet(value: unknown): Readonly<Record<NativePolicyToolId, NativePolicyTool>> {
  const body = record(value);
  exactKeys(body, NATIVE_POLICY_TOOL_IDS);
  return Object.freeze(Object.fromEntries(NATIVE_POLICY_TOOL_IDS.map((id) => {
    const tool = record(body[id]);
    exactKeys(tool, ["path", "digest", "version"]);
    if (typeof tool.path !== "string" || !absolute(tool.path)
      || typeof tool.digest !== "string" || !SHA256.test(tool.digest)
      || typeof tool.version !== "string" || !exactVersion(tool.version)) invalid();
    return [id, Object.freeze({ path: tool.path, digest: tool.digest, version: tool.version })];
  }))) as unknown as Readonly<Record<NativePolicyToolId, NativePolicyTool>>;
}

function agentSet(value: unknown): Readonly<Record<AgentKind, NativePolicyAgent>> {
  const body = record(value);
  exactKeys(body, ["claude-code", "codex-cli"]);
  return Object.freeze(Object.fromEntries((["claude-code", "codex-cli"] as const).map((agent) => {
    const item = record(body[agent]);
    exactKeys(item, ["packageName", "workerBaseImage", "validationHarnessImage", "adapterVersion"]);
    const packageName = agent === "claude-code" ? "@anthropic-ai/claude-code" : "@openai/codex";
    if (item.packageName !== packageName || typeof item.workerBaseImage !== "string" || !OCI_DIGEST_REF.test(item.workerBaseImage)
      || typeof item.validationHarnessImage !== "string" || !OCI_DIGEST_REF.test(item.validationHarnessImage)
      || typeof item.adapterVersion !== "string" || !exactVersion(item.adapterVersion)) invalid();
    return [agent, Object.freeze({
      packageName,
      workerBaseImage: item.workerBaseImage,
      validationHarnessImage: item.validationHarnessImage,
      adapterVersion: item.adapterVersion,
    })];
  }))) as unknown as Readonly<Record<AgentKind, NativePolicyAgent>>;
}

function poolSet(value: unknown): readonly NativePolicyWorkerPool[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) invalid();
  const pools = value.map((candidate) => {
    const pool = record(candidate);
    exactKeys(pool, ["id", "rolloutTarget"]);
    if (typeof pool.id !== "string" || !/^dev(?:elopment)?[-_a-z0-9]{0,100}$/i.test(pool.id)
      || typeof pool.rolloutTarget !== "string" || !SAFE_ID.test(pool.rolloutTarget)) invalid();
    return Object.freeze({ id: pool.id, rolloutTarget: pool.rolloutTarget });
  });
  if (new Set(pools.map((pool) => pool.id)).size !== pools.length
    || JSON.stringify(pools.map((pool) => pool.id).sort()) !== JSON.stringify(pools.map((pool) => pool.id))) invalid();
  return Object.freeze(pools);
}

function stringSet(value: unknown, _label: string, minimum: number, maximum: number, pattern: RegExp): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || value.some((item) => typeof item !== "string" || !pattern.test(item))) invalid();
  const result = value as string[];
  if (new Set(result).size !== result.length || JSON.stringify([...result].sort()) !== JSON.stringify(result)) invalid();
  return Object.freeze([...result]);
}

function strictOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || !url.hostname || url.hostname === "registry.npmjs.org") invalid();
  return url.origin;
}

function exactVersion(value: string): boolean { return VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function absolute(value: string): boolean { return isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/\0/.test(value); }
function integer(value: unknown, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(); return value as number; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(); }
function invalid(): never { throw new Error("Native Agent supply-chain policy is invalid"); }
