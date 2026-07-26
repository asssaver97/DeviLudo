import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { exactAdapterCompatibility, isAdapterVersionAttested } from "../../../lib/agent/adapter-registry";
import type {
  AgentInstallationBuildReceipt,
  AgentInstallationRolloutReceipt,
  AgentVersionCandidateReceipt,
  AgentVersionValidationReceipt,
} from "../../control-plane/src/agent-supply-chain";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { AgentSupplyChainRequest, AgentSupplyChainResponse } from "./contracts";
import { extractOfficialNpmPackage } from "./npm-package-extractor";
import { OfficialNpmAgentRegistry, OfficialPackagePolicyError } from "./official-npm-registry";
import type { NativeAgentSupplyChainPolicy } from "./native-policy-config";
import { NativePolicyViolation, type NativeSupplyChainTools } from "./native-policy-tools";

/** Policy authority that binds official releases, scanner results, images and fleet transitions into receipts. */
export class NativeAgentSupplyChainController {
  readonly #now: () => Date;
  constructor(
    private readonly policy: NativeAgentSupplyChainPolicy,
    private readonly registry: OfficialNpmAgentRegistry,
    private readonly tools: NativeSupplyChainTools,
    now: () => Date = () => new Date(),
  ) { this.#now = now; }

  async probe(): Promise<void> { await Promise.all([this.registry.probe(), this.tools.probe()]); }

  async execute(request: AgentSupplyChainRequest, workRoot: string): Promise<AgentSupplyChainResponse> {
    switch (request.schemaVersion) {
      case "deviludo.agent-version-discovery-request.v1": return this.#discover(request.agent, request.requestedVersion);
      case "deviludo.agent-version-validation-request.v1": return this.#validate(request.candidate, workRoot);
      case "deviludo.agent-installation-build-request.v1": return this.#build(request, workRoot);
      case "deviludo.agent-installation-rollout-request.v1": return this.#rollout(request);
    }
  }

  async #discover(agent: "claude-code" | "codex-cli", requestedVersion: string | null) {
    const release = await this.registry.resolve(agent, requestedVersion);
    const discoveredAt = timestamp(this.#now());
    const core = Object.freeze({
      agent,
      version: release.version,
      source: release.tarballUrl,
      sourceDigest: release.sourceDigest,
      releaseNotesUrl: agent === "claude-code"
        ? "https://github.com/anthropics/claude-code/releases"
        : "https://github.com/openai/codex/releases",
      catalogReceiptId: `catalog-${agent}-${release.version}`,
      discoveredAt,
    });
    const candidate: AgentVersionCandidateReceipt = Object.freeze({ ...core, catalogReceiptDigest: sha256Canonical(core) });
    return Object.freeze({ schemaVersion: "deviludo.agent-version-discovery-receipt.v1" as const, candidates: Object.freeze([candidate]) });
  }

  async #validate(candidate: AgentVersionCandidateReceipt, workRoot: string): Promise<AgentVersionValidationReceipt> {
    const release = await this.#boundRelease(candidate);
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    const attemptRoot = await mkdtemp(join(workRoot, "native-attempt-"));
    const packagePath = join(attemptRoot, "official-agent.tgz");
    let artifact;
    try { artifact = await this.registry.download(release, packagePath); }
    catch (error) {
      if (error instanceof OfficialPackagePolicyError) throw new NativePolicyViolation(error.code, error.evidenceDigest);
      throw error;
    }
    const extractionRoot = join(attemptRoot, "official-agent-package");
    try {
      await extractOfficialNpmPackage(packagePath, extractionRoot, {
        packageName: release.packageName, version: release.version, maximumBytes: this.policy.maxExtractedBytes,
      });
    } catch {
      throw new NativePolicyViolation("INTEGRITY_MISMATCH", sha256Canonical({ release, artifact, stage: "safe-extraction" }));
    }
    const result = await this.tools.validate({ agent: candidate.agent, release, artifact, extractedRoot: extractionRoot, workRoot: attemptRoot });
    const validatedAt = timestamp(this.#now());
    const validatedAdapterVersion = this.policy.agents[candidate.agent].adapterVersion;
    const adapterCompatibility = exactAdapterCompatibility(validatedAdapterVersion);
    const core = Object.freeze({
      agent: candidate.agent,
      version: candidate.version,
      sourceDigest: candidate.sourceDigest,
      integrity: result.integrity,
      signatureVerified: true as const,
      sbomRef: result.sbomRef,
      scan: "PASS" as const,
      supplyChainEvidenceDigest: result.evidenceDigest,
      validatedAdapterVersion,
      adapterCompatibility,
      validationReceiptId: `validation-${candidate.agent}-${candidate.version}`,
      validatedAt,
    });
    return Object.freeze({ ...core, validationReceiptDigest: sha256Canonical(core) });
  }

  async #build(
    request: Extract<AgentSupplyChainRequest, { schemaVersion: "deviludo.agent-installation-build-request.v1" }>,
    workRoot: string,
  ): Promise<AgentInstallationBuildReceipt> {
    let release;
    try { release = await this.#boundRelease(request.candidate); }
    catch (error) {
      if (error instanceof NativePolicyViolation) {
        throw new NativePolicyViolation("IMAGE_BUILD_FAILED", sha256Canonical({ evidenceDigest: error.evidenceDigest, stage: "build-catalog-binding" }));
      }
      throw error;
    }
    if (request.validation.agent !== request.candidate.agent || request.validation.version !== request.candidate.version
      || request.validation.sourceDigest !== request.candidate.sourceDigest
      || request.adapterVersion !== this.policy.agents[request.candidate.agent].adapterVersion
      || !isAdapterVersionAttested(request.adapterVersion, request.validation.validatedAdapterVersion, request.validation.adapterCompatibility)
      || !this.policy.workerPools.some((pool) => pool.id === request.workerPool)) {
      throw new NativePolicyViolation("IMAGE_BUILD_FAILED", sha256Canonical({ request, stage: "immutable-build-binding" }));
    }
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    const attemptRoot = await mkdtemp(join(workRoot, "native-attempt-"));
    const packagePath = join(attemptRoot, "verified-agent.tgz");
    let artifact;
    try { artifact = await this.registry.download(release, packagePath); }
    catch (error) {
      if (error instanceof OfficialPackagePolicyError) {
        throw new NativePolicyViolation("IMAGE_BUILD_FAILED", sha256Canonical({ evidenceDigest: error.evidenceDigest, stage: "build-download" }));
      }
      throw error;
    }
    if (request.validation.integrity !== `sha256:${artifact.sha256}`) {
      throw new NativePolicyViolation("IMAGE_BUILD_FAILED", sha256Canonical({ request, artifact, stage: "build-redownload" }));
    }
    const result = await this.tools.build({
      agent: request.candidate.agent,
      version: request.candidate.version,
      installationId: request.installationId,
      artifact,
      workerPool: request.workerPool,
      adapterVersion: request.adapterVersion,
      workRoot: attemptRoot,
    });
    const completedAt = timestamp(this.#now());
    const core = Object.freeze({
      installationId: request.installationId,
      agent: request.candidate.agent,
      version: request.candidate.version,
      workerPool: request.workerPool,
      adapterVersion: request.adapterVersion,
      workerImageId: result.workerImageId,
      imageDigest: result.imageDigest,
      rollbackInstallationId: request.rollbackInstallationId,
      stages: Object.freeze(["BUILDING", "SCANNING", "SMOKE_TESTING", "READY"] as const),
      health: "HEALTHY" as const,
      selfUpdateDisabled: true as const,
      buildReceiptId: `build-${request.installationId}`,
      runtimeBinding: result.runtimeBinding,
      fleetHealth: result.fleetHealth,
      completedAt,
    });
    return Object.freeze({ ...core, buildReceiptDigest: sha256Canonical(core) });
  }

  async #rollout(
    request: Extract<AgentSupplyChainRequest, { schemaVersion: "deviludo.agent-installation-rollout-request.v1" }>,
  ): Promise<AgentInstallationRolloutReceipt> {
    const result = await this.tools.rollout(request);
    const completedAt = timestamp(this.#now());
    const core = Object.freeze({
      installationId: request.installationId,
      imageDigest: request.imageDigest,
      action: request.action,
      fromPercent: request.fromPercent,
      toPercent: request.toPercent,
      state: request.action === "DRAIN" ? "DRAINING" : request.action === "RETIRE" ? "RETIRED"
        : request.toPercent === 0 ? "READY" : request.toPercent === 100 ? "ACTIVE" : "CANARY",
      health: "HEALTHY" as const,
      newTasksOnly: true as const,
      runningTasksUnaffected: true as const,
      runtimeBinding: result.runtimeBinding,
      fleetHealth: result.fleetHealth,
      rolloutReceiptId: `rollout-${request.installationId}-${request.action.toLowerCase()}-${request.toPercent}`,
      completedAt,
    });
    return Object.freeze({ ...core, rolloutReceiptDigest: sha256Canonical(core) });
  }

  async #boundRelease(candidate: AgentVersionCandidateReceipt) {
    const release = await this.registry.resolve(candidate.agent, candidate.version);
    if (candidate.source !== release.tarballUrl || candidate.sourceDigest !== release.sourceDigest) {
      throw new NativePolicyViolation("SIGNATURE_INVALID", sha256Canonical({ candidate, release, stage: "catalog-binding" }));
    }
    return release;
  }
}

function timestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Native policy clock is invalid");
  return now.toISOString();
}
