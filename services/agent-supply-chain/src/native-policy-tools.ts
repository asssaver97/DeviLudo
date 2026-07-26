import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Canonical } from "../../runner-control/src/canonical";
import {
  parseAgentInstallationFleetHealth,
  parseAgentInstallationRuntimeBinding,
  sameAgentInstallationRuntimeBinding,
  type AgentInstallationFleetHealth,
  type AgentInstallationRuntimeBinding,
} from "../../../lib/agent/installation-runtime";
import type { AgentKind } from "../../control-plane/src/contracts";
import type { AgentInstallationRolloutRequest } from "./contracts";
import type { NativeAgentSupplyChainPolicy, NativePolicyToolId } from "./native-policy-config";
import type { OfficialAgentRelease, VerifiedAgentPackage } from "./official-npm-registry";

const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type NativePolicyFailureCode =
  | "SIGNATURE_INVALID" | "INTEGRITY_MISMATCH" | "SBOM_INVALID" | "MALWARE_DETECTED"
  | "VULNERABILITY_POLICY_FAILED" | "ADAPTER_CONTRACT_FAILED" | "SANDBOX_POLICY_FAILED"
  | "SYNTHETIC_TASK_FAILED" | "IMAGE_BUILD_FAILED" | "CANARY_HEALTH_FAILED" | "DEPLOYMENT_HEALTH_FAILED";

export class NativePolicyViolation extends Error {
  constructor(readonly failureCode: NativePolicyFailureCode, readonly evidenceDigest: string) {
    super("Agent supply-chain policy rejected the operation");
    this.name = "NativePolicyViolation";
  }
}

export interface NativeValidationResult {
  readonly integrity: string;
  readonly sbomRef: string;
  readonly evidenceDigest: string;
}
export interface NativeBuildResult {
  readonly workerImageId: string;
  readonly imageDigest: string;
  readonly runtimeBinding: AgentInstallationRuntimeBinding;
  readonly fleetHealth: AgentInstallationFleetHealth;
}
export interface NativeRolloutResult {
  readonly runtimeBinding: AgentInstallationRuntimeBinding;
  readonly fleetHealth: AgentInstallationFleetHealth;
}

export interface NativeSupplyChainTools {
  probe(): Promise<void>;
  validate(input: Readonly<{
    agent: AgentKind; release: OfficialAgentRelease; artifact: VerifiedAgentPackage; extractedRoot: string; workRoot: string;
  }>): Promise<NativeValidationResult>;
  build(input: Readonly<{
    agent: AgentKind; version: string; installationId: string; artifact: VerifiedAgentPackage; workerPool: string;
    adapterVersion: string; workRoot: string;
  }>): Promise<NativeBuildResult>;
  rollout(request: AgentInstallationRolloutRequest): Promise<NativeRolloutResult>;
}

export interface NativeToolProcessResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
export type NativeToolProcess = (executable: string, args: readonly string[], options: Readonly<{
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number;
}>) => Promise<NativeToolProcessResult>;

/** Executes only policy-selected, digest-locked binaries with fixed argument templates. */
export class LockedNativeSupplyChainTools implements NativeSupplyChainTools {
  readonly #process: NativeToolProcess;
  constructor(private readonly policy: NativeAgentSupplyChainPolicy, process: NativeToolProcess = executeTool) {
    this.#process = process;
  }

  async probe(): Promise<void> {
    await Promise.all([
      ...Object.keys(this.policy.tools).map((id) => this.#verifyTool(id as NativePolicyToolId)),
      verifyDirectory(this.policy.registryConfigDirectory),
      verifyRegularFile(join(this.policy.registryConfigDirectory, "config.json"), 1024 * 1024),
      verifyDirectory(this.policy.scannerDataDirectory),
      verifyRegularFile(this.policy.fleetConfigFile, 1024 * 1024),
    ]);
  }

  async validate(input: Parameters<NativeSupplyChainTools["validate"]>[0]): Promise<NativeValidationResult> {
    await this.probe();
    const clam = await this.#run("clamscan", ["--no-summary", "--infected", "--recursive", input.extractedRoot], input.workRoot, 5 * 60_000);
    if (clam.exitCode === 1) violation("MALWARE_DETECTED", "clamscan", input.release, clam);
    if (clam.exitCode !== 0) transient();

    const trivy = await this.#run("trivy", [
      "fs", "--offline-scan", "--skip-db-update", "--scanners", "vuln,secret,misconfig",
      "--severity", "HIGH,CRITICAL", "--exit-code", "42", "--no-progress", input.extractedRoot,
    ], input.workRoot, 5 * 60_000);
    if (trivy.exitCode === 42) violation("VULNERABILITY_POLICY_FAILED", "trivy-fs", input.release, trivy);
    if (trivy.exitCode !== 0) transient();

    const sbomPath = join(input.workRoot, "sbom.spdx.json");
    const syft = await this.#run("syft", [input.extractedRoot, "-o", `spdx-json=${sbomPath}`], input.workRoot, 3 * 60_000);
    if (syft.exitCode !== 0) violation("SBOM_INVALID", "syft", input.release, syft);
    const sbomDigest = await verifiedJsonDigest(sbomPath);

    const harness = await this.#run("nerdctl", [
      "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
      "--user", "65532:65532", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "-v", `${input.artifact.path}:/input/agent.tgz:ro`, this.policy.agents[input.agent].validationHarnessImage,
      "verify-agent-package", "--agent", input.agent, "--adapter-version", this.policy.agents[input.agent].adapterVersion,
      "--package", "/input/agent.tgz",
    ], input.workRoot, 5 * 60_000);
    if (harness.exitCode === 42) violation("ADAPTER_CONTRACT_FAILED", "adapter-contract", input.release, harness);
    if (harness.exitCode === 43) violation("SANDBOX_POLICY_FAILED", "sandbox-contract", input.release, harness);
    if (harness.exitCode === 44) violation("SYNTHETIC_TASK_FAILED", "synthetic-task", input.release, harness);
    if (harness.exitCode !== 0) transient();

    const tag = `${registryAuthority(this.policy.internalRegistryOrigin)}/${this.policy.sbomRepositoryPrefix}/${input.agent}:${input.release.version}`;
    const mirroredPackage = `${registryAuthority(this.policy.internalRegistryOrigin)}/${this.policy.packageRepositoryPrefix}/${input.agent}:${input.release.version}`;
    const packagePush = await this.#run("oras", [
      "push", "--registry-config", join(this.policy.registryConfigDirectory, "config.json"), "--format", "json", mirroredPackage,
      `${input.artifact.path}:application/vnd.npm.package+gzip`,
    ], input.workRoot, 3 * 60_000);
    const packageDigest = descriptorDigest(packagePush);
    const sbomPush = await this.#run("oras", [
      "push", "--registry-config", join(this.policy.registryConfigDirectory, "config.json"), "--format", "json", tag,
      `${sbomPath}:application/spdx+json`,
    ], input.workRoot, 3 * 60_000);
    const sbomManifestDigest = descriptorDigest(sbomPush);
    const evidenceDigest = sha256Canonical({
      release: input.release, packageSha256: input.artifact.sha256, packageManifestDigest: packageDigest, sbomDigest, sbomManifestDigest,
      gates: ["npm-signature", "sha512-integrity", "malware", "vulnerability", "sbom", "adapter-contract", "sandbox", "synthetic-task"],
      policyVersion: this.policy.policyVersion, tools: this.policy.tools, agentPolicy: this.policy.agents[input.agent],
    });
    return Object.freeze({
      integrity: `sha256:${input.artifact.sha256}`,
      sbomRef: `oci://${tag.split(":").slice(0, -1).join(":")}@${sbomManifestDigest}`,
      evidenceDigest,
    });
  }

  async build(input: Parameters<NativeSupplyChainTools["build"]>[0]): Promise<NativeBuildResult> {
    await this.probe();
    const agentPolicy = this.policy.agents[input.agent];
    if (input.adapterVersion !== agentPolicy.adapterVersion) transient();
    const context = join(input.workRoot, "image-context");
    await mkdir(context, { recursive: false, mode: 0o700 });
    const archiveName = "agent.tgz";
    const archive = await readFile(input.artifact.path);
    if (createHash("sha256").update(archive).digest("hex") !== input.artifact.sha256) {
      violation("IMAGE_BUILD_FAILED", "build-input", input.artifact, { exitCode: 0, stdout: "", stderr: "" });
    }
    await writeFile(join(context, archiveName), archive, { flag: "wx", mode: 0o400 });
    const containerfile = [
      `FROM ${agentPolicy.workerBaseImage}`,
      `COPY ${archiveName} /tmp/${archiveName}`,
      `RUN [\"/usr/local/bin/deviludo-install-agent\",\"/tmp/${archiveName}\",\"${input.agent}\",\"${input.adapterVersion}\"]`,
      "ENV DISABLE_UPDATES=1",
      "USER 65532:65532",
      "ENTRYPOINT [\"/usr/local/bin/deviludo-agent-adapter\"]",
      "",
    ].join("\n");
    await writeFile(join(context, "Containerfile"), containerfile, { flag: "wx", mode: 0o400 });
    const imageTag = `build-${sha256Canonical({ installationId: input.installationId, version: input.version, packageSha256: input.artifact.sha256 }).slice(0, 32)}`;
    const imageName = `${registryAuthority(this.policy.internalRegistryOrigin)}/${this.policy.imageRepositoryPrefix}/${input.agent}:${imageTag}`;
    const metadataPath = join(input.workRoot, "build-metadata.json");
    const build = await this.#run("buildctl", [
      "build", "--frontend", "dockerfile.v0", "--local", `context=${context}`, "--local", `dockerfile=${context}`,
      "--opt", "filename=Containerfile", "--metadata-file", metadataPath,
      "--output", `type=image,name=${imageName},push=true`,
    ], input.workRoot, 8 * 60_000);
    if (build.exitCode !== 0) violation("IMAGE_BUILD_FAILED", "buildkit", input.artifact, build);
    const imageDigest = await buildMetadataDigest(metadataPath);
    const imageRef = `${imageName}@${imageDigest}`;
    const scan = await this.#run("trivy", [
      "image", "--offline-scan", "--skip-db-update", "--severity", "HIGH,CRITICAL", "--exit-code", "42",
      "--no-progress", imageRef,
    ], input.workRoot, 5 * 60_000);
    if (scan.exitCode === 42) violation("VULNERABILITY_POLICY_FAILED", "trivy-image", input.artifact, scan);
    if (scan.exitCode !== 0) transient();
    const sign = await this.#run("cosign", ["sign", "--yes", "--key", this.policy.signingKeyRef, imageRef], input.workRoot, 3 * 60_000);
    if (sign.exitCode !== 0) transient();
    const signatureCheck = await this.#run("cosign", ["verify", "--key", this.policy.signingKeyRef, imageRef], input.workRoot, 3 * 60_000);
    if (signatureCheck.exitCode !== 0) transient();
    const smoke = await this.#run("nerdctl", [
      "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "65532:65532", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      imageRef, "probe", "--agent", input.agent, "--adapter-version", input.adapterVersion,
    ], input.workRoot, 3 * 60_000);
    if (smoke.exitCode === 42) violation("ADAPTER_CONTRACT_FAILED", "image-smoke", input.artifact, smoke);
    if (smoke.exitCode !== 0) transient();
    const pool = this.policy.workerPools.find((candidate) => candidate.id === input.workerPool);
    if (!pool) transient();
    const registration = await this.#run("fleetctl", [
      "--config", this.policy.fleetConfigFile, "installation", "register",
      "--installation-id", input.installationId, "--target", pool.rolloutTarget, "--image-digest", imageDigest,
      "--new-tasks-only", "--output", "json",
    ], input.workRoot, 3 * 60_000);
    const registered = jsonRecord(registration);
    if (registered.installationId !== input.installationId || registered.target !== pool.rolloutTarget
      || registered.imageDigest !== imageDigest || registered.percent !== 0 || registered.health !== "READY") transient();
    let runtimeBinding: AgentInstallationRuntimeBinding; let fleetHealth: AgentInstallationFleetHealth;
    try {
      runtimeBinding = parseAgentInstallationRuntimeBinding(registered.runtimeBinding, {
        installationId: input.installationId,
        workerPool: input.workerPool,
        agent: input.agent,
        exactAgentVersion: input.version,
        adapterVersion: input.adapterVersion,
        workerImageDigest: imageDigest,
      });
      fleetHealth = parseAgentInstallationFleetHealth(registered.fleetHealth, { requireReadyWorker: true });
    } catch { transient(); }
    return Object.freeze({
      workerImageId: `worker-image-${imageDigest.slice(7, 39)}`,
      imageDigest,
      runtimeBinding,
      fleetHealth,
    });
  }

  async rollout(request: AgentInstallationRolloutRequest): Promise<NativeRolloutResult> {
    await this.probe();
    const command = request.action.toLowerCase();
    const result = await this.#run("fleetctl", [
      "--config", this.policy.fleetConfigFile, "installation", command,
      "--installation-id", request.installationId, "--image-digest", request.imageDigest,
      "--from-percent", String(request.fromPercent), "--to-percent", String(request.toPercent), "--new-tasks-only", "--wait", "--output", "json",
    ], resolve(this.policy.fleetConfigFile, ".."), 8 * 60_000);
    if (result.exitCode === 42) violation("CANARY_HEALTH_FAILED", "fleet-canary", request, result);
    if (result.exitCode === 43) violation("DEPLOYMENT_HEALTH_FAILED", "fleet-deployment", request, result);
    if (result.exitCode !== 0) transient();
    const record = jsonRecord(result);
    if (record.installationId !== request.installationId
      || record.imageDigest !== request.imageDigest || record.percent !== request.toPercent || record.health !== "HEALTHY") transient();
    let runtimeBinding: AgentInstallationRuntimeBinding; let fleetHealth: AgentInstallationFleetHealth;
    try {
      runtimeBinding = parseAgentInstallationRuntimeBinding(record.runtimeBinding, {
        installationId: request.installationId,
        workerImageDigest: request.imageDigest,
      });
      if (!sameAgentInstallationRuntimeBinding(runtimeBinding, request.runtimeBinding)) transient();
      fleetHealth = parseAgentInstallationFleetHealth(record.fleetHealth, { requireReadyWorker: request.action === "ADVANCE" });
    } catch { transient(); }
    return Object.freeze({ runtimeBinding, fleetHealth });
  }

  async #run(id: NativePolicyToolId, args: readonly string[], cwd: string, timeoutMs: number): Promise<NativeToolProcessResult> {
    await this.#verifyTool(id);
    return this.#process(this.policy.tools[id].path, args, {
      cwd, env: controlledEnvironment(cwd, this.policy.registryConfigDirectory, this.policy.scannerDataDirectory),
      timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  }

  async #verifyTool(id: NativePolicyToolId): Promise<void> {
    const tool = this.policy.tools[id];
    const metadata = await lstat(tool.path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 1024 * 1024 * 1024
      || (metadata.mode & 0o111) === 0) transient();
    const file = await open(tool.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < metadata.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - offset), offset);
        if (bytesRead < 1) transient();
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || hash.digest("hex") !== tool.digest) transient();
    } finally { await file.close(); }
  }
}

export function executeTool(executable: string, args: readonly string[], options: Parameters<NativeToolProcess>[2]): Promise<NativeToolProcessResult> {
  return new Promise((accept) => execFile(executable, [...args], {
    cwd: options.cwd, env: options.env, encoding: "utf8", windowsHide: true, timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes, shell: false,
  }, (error, stdout, stderr) => accept(Object.freeze({
    exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? (error as Error & { code: number }).code : error ? 1 : 0,
    stdout: bounded(stdout), stderr: bounded(stderr),
  }))));
}

function descriptorDigest(result: NativeToolProcessResult): string {
  const body = jsonRecord(result);
  const digest = body.digest ?? body.manifestDigest;
  if (typeof digest !== "string" || !OCI_DIGEST.test(digest)) transient();
  return digest;
}
function jsonRecord(result: NativeToolProcessResult): Record<string, unknown> {
  if (result.exitCode !== 0) transient();
  let body: unknown;
  try { body = JSON.parse(result.stdout) as unknown; } catch { transient(); }
  if (!body || typeof body !== "object" || Array.isArray(body)) transient();
  return body as Record<string, unknown>;
}
async function buildMetadataDigest(path: string): Promise<string> {
  let body: unknown;
  try { body = JSON.parse(await readFile(path, "utf8")) as unknown; } catch { transient(); }
  const digest = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)["containerimage.digest"] : null;
  if (typeof digest !== "string" || !OCI_DIGEST.test(digest)) transient();
  return digest;
}
async function verifiedJsonDigest(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 256 * 1024 * 1024) violation("SBOM_INVALID", "sbom-file", path, { exitCode: 0, stdout: "", stderr: "" });
    const value = await file.readFile();
    try { JSON.parse(value.toString("utf8")) as unknown; } catch { violation("SBOM_INVALID", "sbom-json", path, { exitCode: 0, stdout: "", stderr: "" }); }
    return createHash("sha256").update(value).digest("hex");
  } finally { await file.close(); }
}
async function verifyDirectory(path: string): Promise<void> { const value = await lstat(path); if (!value.isDirectory() || value.isSymbolicLink()) transient(); }
async function verifyRegularFile(path: string, max: number): Promise<void> { const value = await lstat(path); if (!value.isFile() || value.isSymbolicLink() || value.size < 2 || value.size > max) transient(); }
function registryAuthority(origin: string): string { const url = new URL(origin); return url.host; }
function controlledEnvironment(root: string, registry: string, scanner: string): NodeJS.ProcessEnv {
  return Object.freeze({
    NODE_ENV: "production", HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root, LANG: "C.UTF-8",
    PATH: "", DISABLE_UPDATES: "1", DOCKER_CONFIG: registry, TRIVY_CACHE_DIR: scanner,
  });
}
function violation(code: NativePolicyFailureCode, gate: string, input: unknown, result: NativeToolProcessResult): never {
  throw new NativePolicyViolation(code, sha256Canonical({ gate, input, exitCode: result.exitCode }));
}
function transient(): never { throw new Error("Agent supply-chain infrastructure is unavailable"); }
function bounded(value: string): string { return value.length > MAX_OUTPUT_BYTES ? value.slice(0, MAX_OUTPUT_BYTES) : value; }
