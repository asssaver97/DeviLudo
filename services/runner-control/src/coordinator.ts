import { createPublicKey } from "node:crypto";
import {
  acceptPlatformRunnerEvent,
  createEvidenceBundle,
  type EvidenceBundle,
  type PlatformRunnerLease,
  type RunnerEvent,
  type RunnerEventCursor,
} from "../../../lib/domain/e2e";
import {
  TARGET_PLATFORMS,
  assertGitSha,
  assertSha256,
  deepFreeze,
  uniqueSorted,
  type TargetPlatform,
} from "../../../lib/domain/types";
import { sha256Canonical, signCanonical, verifyCanonical } from "./canonical";
import type {
  MatrixAttemptSpec,
  MatrixAttemptState,
  PlatformEvidenceManifest,
  PlatformLeaseState,
  RegisteredRunner,
  RunnerAdmissionPolicy,
  RunnerCapabilities,
  RunnerEventReceipt,
  RunnerJobPayload,
  RunnerJobSignerOptions,
  RunnerJobVerificationContext,
  SignedRunnerJob,
  TlsRunnerIdentity,
} from "./contracts";

export const REQUIRED_RUNNER_EVIDENCE: RunnerJobPayload["requiredEvidence"] = Object.freeze([
  "logs",
  "junit",
  "input-timeline",
  "screenshots",
  "video",
  "production-export",
]);

/**
 * Deterministic runner scheduler/ingress core. The in-memory maps are a local
 * contract implementation; production must place the same compare-and-swap
 * operations behind PostgreSQL transactions and forced RLS.
 */
export class RunnerMatrixCoordinator {
  readonly #admission: RunnerAdmissionPolicy;
  readonly #signer: RunnerJobSignerOptions;
  readonly #runners = new Map<string, RegisteredRunner>();
  readonly #attempts = new Map<string, MatrixAttemptState>();
  readonly #events = new Map<string, RunnerEvent[]>();

  constructor(input: { readonly admission: RunnerAdmissionPolicy; readonly signer: RunnerJobSignerOptions }) {
    this.#admission = input.admission;
    this.#signer = input.signer;
    const publicKey = createPublicKey(input.signer.privateKey);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Runner job signer must be an Ed25519 key");
    if (!input.signer.keyId.trim()) throw new Error("Runner job signing key ID is required");
  }

  async register(
    identity: TlsRunnerIdentity,
    capabilities: RunnerCapabilities,
    at = new Date().toISOString(),
  ): Promise<RegisteredRunner> {
    validateRunnerIdentity(identity, at);
    validateRunnerCapabilities(capabilities);
    if (!(await this.#admission.authorize({ identity, capabilities }))) {
      throw new Error("Runner admission policy rejected this workload identity");
    }
    const existing = this.#runners.get(capabilities.runnerId);
    if (existing && (existing.spiffeId !== identity.spiffeId || existing.certificateFingerprint !== identity.certificateFingerprint)) {
      throw new Error("Runner ID is already bound to another workload identity");
    }
    if (existing && immutableCapabilityDigest(existing) !== immutableCapabilityDigest(capabilities)) {
      throw new Error("Runner capabilities are immutable; drain and enroll a new runner identity");
    }
    const runner: RegisteredRunner = deepFreeze({
      ...capabilities,
      spiffeId: identity.spiffeId,
      certificateFingerprint: identity.certificateFingerprint,
      certificateSerial: identity.certificateSerial,
      certificateNotAfter: identity.certificateNotAfter,
      state: existing?.state === "DRAINING" ? "DRAINING" : "ONLINE",
      registeredAt: existing?.registeredAt ?? at,
      lastSeenAt: at,
    });
    this.#runners.set(runner.runnerId, runner);
    return runner;
  }

  createAttempt(spec: MatrixAttemptSpec, at = new Date().toISOString()): MatrixAttemptState {
    validateAttemptSpec(spec);
    const normalized = deepFreeze({ ...spec, targetMatrix: uniqueSorted(spec.targetMatrix) });
    if (this.#attempts.has(spec.attemptId)) {
      const existing = this.#attempts.get(spec.attemptId) as MatrixAttemptState;
      if (sha256Canonical(existing.spec) !== sha256Canonical(normalized)) throw new Error("Attempt ID was reused with a different immutable specification");
      return existing;
    }
    const attempt: MatrixAttemptState = deepFreeze({
      spec: normalized,
      state: "QUEUED",
      platforms: {},
      evidenceBundle: null,
      createdAt: at,
      updatedAt: at,
    });
    this.#attempts.set(spec.attemptId, attempt);
    this.#events.set(spec.attemptId, []);
    return attempt;
  }

  lease(
    identity: TlsRunnerIdentity,
    runnerId: string,
    attemptId: string,
    at = new Date().toISOString(),
  ): SignedRunnerJob {
    const runner = this.#authorizedRunner(identity, runnerId, at);
    if (runner.state !== "ONLINE") throw new Error("Runner is not eligible for a new lease");
    const attempt = this.#requireAttempt(attemptId);
    if (attempt.state === "PASSED" || attempt.state === "FAILED" || attempt.state === "INVALIDATED") {
      throw new Error("Attempt is terminal");
    }
    if (!attempt.spec.targetMatrix.includes(runner.platform)) throw new Error("Runner platform is not selected by this attempt");
    assertRunnerMatchesAttempt(runner, attempt.spec);
    const previous = attempt.platforms[runner.platform];
    if (previous?.cursor.terminal) throw new Error("Platform lease is already complete");
    if (previous && !previous.cursor.terminal && Date.parse(previous.lease.leaseExpiresAt) >= Date.parse(at)) {
      if (previous.lease.runnerId !== runnerId) throw new Error("Platform already has an active lease");
      return this.#signedJob(attempt.spec, runner, previous.lease);
    }
    const fencingToken = (previous?.lease.fencingToken ?? 0) + 1;
    const leaseExpiresAt = new Date(Date.parse(at) + attempt.spec.leaseDurationSeconds * 1_000).toISOString();
    const lease: PlatformRunnerLease = deepFreeze({
      attemptId,
      runnerId,
      platform: runner.platform,
      fencingToken,
      leaseExpiresAt,
      commitSha: attempt.spec.commitSha,
      sourceDigest: attempt.spec.sourceDigest,
      specRevisionId: attempt.spec.specRevisionId,
      specDigest: attempt.spec.specDigest,
      testPlanDigest: attempt.spec.testPlanDigest,
      targetMatrix: attempt.spec.targetMatrix,
    });
    const nextPlatform: PlatformLeaseState = deepFreeze({
      lease,
      cursor: { lastAcceptedSeqNo: 0, completedPlatforms: {}, terminal: false },
      evidence: null,
    });
    this.#replaceAttempt(attempt, {
      state: "RUNNING",
      platforms: { ...attempt.platforms, [runner.platform]: nextPlatform },
      updatedAt: at,
    });
    return this.#signedJob(attempt.spec, runner, lease);
  }

  submitEvidence(
    identity: TlsRunnerIdentity,
    manifest: PlatformEvidenceManifest,
    at = new Date().toISOString(),
  ): PlatformEvidenceManifest {
    const runner = this.#authorizedRunner(identity, manifest.runnerId, at);
    const attempt = this.#requireAttempt(manifest.attemptId);
    if (attempt.state === "PASSED" || attempt.state === "FAILED" || attempt.state === "INVALIDATED") throw new Error("Attempt is terminal");
    const platformState = attempt.platforms[manifest.platform];
    if (!platformState) throw new Error("Platform has no active lease");
    validatePlatformEvidenceManifest(manifest, attempt.spec, runner, platformState.lease);
    if (platformState.evidence) {
      if (platformState.evidence.manifestDigest !== manifest.manifestDigest) throw new Error("Platform evidence is immutable for a fencing token");
      return platformState.evidence;
    }
    const nextPlatform = deepFreeze({ ...platformState, evidence: deepFreeze({ ...manifest }) });
    this.#replaceAttempt(attempt, {
      platforms: { ...attempt.platforms, [manifest.platform]: nextPlatform },
      updatedAt: at,
    });
    return manifest;
  }

  acceptEvent(
    identity: TlsRunnerIdentity,
    event: RunnerEvent,
    receivedAt = new Date().toISOString(),
  ): RunnerEventReceipt {
    this.#authorizedRunner(identity, event.runnerId, receivedAt);
    const attempt = this.#requireAttempt(event.attemptId);
    if (attempt.state === "PASSED" || attempt.state === "FAILED" || attempt.state === "INVALIDATED") throw new Error("Attempt is terminal");
    const platformState = attempt.platforms[event.platform];
    if (!platformState) throw new Error("Platform has no active lease");
    validateRunnerEventShape(event, platformState.cursor, receivedAt);
    if (event.type === "PLATFORM_COMPLETED") {
      if (!platformState.evidence) throw new Error("Platform completion requires a validated evidence manifest");
      if (event.artifactDigest !== platformState.evidence.manifestDigest) throw new Error("Platform completion evidence digest mismatch");
      if (event.status !== platformState.evidence.status) throw new Error("Platform completion status does not match evidence");
    }
    const decision = acceptPlatformRunnerEvent(platformState.lease, platformState.cursor, event, receivedAt);
    if (!decision.accepted) throw new Error(`Runner event rejected: ${decision.reason}`);
    const nextPlatform = deepFreeze({ ...platformState, cursor: decision.cursor });
    const platforms = { ...attempt.platforms, [event.platform]: nextPlatform };
    let nextState: MatrixAttemptState["state"] = "RUNNING";
    let evidenceBundle: EvidenceBundle | null = null;
    if (attempt.spec.targetMatrix.every((platform) => platforms[platform]?.cursor.terminal)) {
      nextState = attempt.spec.targetMatrix.every((platform) => platforms[platform]?.evidence?.status === "PASSED") ? "PASSED" : "FAILED";
      evidenceBundle = this.#buildEvidenceBundle(attempt.spec, platforms, nextState, receivedAt);
    }
    const updated = this.#replaceAttempt(attempt, { state: nextState, platforms, evidenceBundle, updatedAt: receivedAt });
    const stream = this.#events.get(event.attemptId) ?? [];
    stream.push(deepFreeze({ ...event }) as RunnerEvent);
    this.#events.set(event.attemptId, stream);
    return deepFreeze({ accepted: true, attemptState: updated.state, cursor: decision.cursor, event, evidenceBundle: updated.evidenceBundle });
  }

  invalidate(attemptId: string, at = new Date().toISOString()): MatrixAttemptState {
    const attempt = this.#requireAttempt(attemptId);
    if (attempt.state === "INVALIDATED") return attempt;
    return this.#replaceAttempt(attempt, { state: "INVALIDATED", evidenceBundle: null, updatedAt: at });
  }

  getAttempt(attemptId: string): MatrixAttemptState | null {
    return this.#attempts.get(attemptId) ?? null;
  }

  listRunners(): readonly RegisteredRunner[] {
    return deepFreeze([...this.#runners.values()]);
  }

  events(attemptId: string): readonly RunnerEvent[] {
    return deepFreeze([...(this.#events.get(attemptId) ?? [])]);
  }

  #signedJob(spec: MatrixAttemptSpec, runner: RegisteredRunner, lease: PlatformRunnerLease): SignedRunnerJob {
    const payload: RunnerJobPayload = deepFreeze({
      schemaVersion: "deviludo.runner-job.v2",
      attemptId: spec.attemptId,
      tenantId: spec.tenantId,
      projectId: spec.projectId,
      runId: spec.runId,
      iterationId: spec.iterationId,
      runnerId: runner.runnerId,
      platform: runner.platform,
      fencingToken: lease.fencingToken,
      leaseExpiresAt: lease.leaseExpiresAt,
      executionLockId: spec.executionLockId,
      executionLockDigest: spec.executionLockDigest,
      commitSha: spec.commitSha,
      sourceDigest: spec.sourceDigest,
      execution: {
        kind: "SOURCE_ARTIFACT",
        objectKey: spec.sourceArtifact.objectKey,
        artifactDigest: spec.sourceArtifact.digest,
      },
      specRevisionId: spec.specRevisionId,
      specDigest: spec.specDigest,
      testPlanDigest: spec.testPlanDigest,
      runnerToolchainRevisionId: spec.runnerToolchainRevisionId,
      runnerToolchainDigest: spec.runnerToolchainDigest,
      targetMatrix: spec.targetMatrix,
      requiredGodotVersion: spec.requiredGodotVersion,
      godotTestKitDigest: spec.godotTestKitDigest,
      exportTemplatesDigest: spec.exportTemplates[runner.platform],
      runnerCapabilityDigest: runner.capabilityDigest,
      buildManifestDigest: spec.buildManifestDigest,
      sbomDigest: spec.sbomDigest,
      vulnerabilityScanDigest: spec.vulnerabilityScanDigest,
      assetLicenseLedgerDigest: spec.assetLicenseLedgerDigest,
      requiredEvidence: REQUIRED_RUNNER_EVIDENCE,
    });
    return deepFreeze({
      payload,
      signature: {
        algorithm: "Ed25519",
        keyId: this.#signer.keyId,
        value: signCanonical(this.#signer.privateKey, payload),
      },
    });
  }

  #authorizedRunner(identity: TlsRunnerIdentity, runnerId: string, at: string): RegisteredRunner {
    validateRunnerIdentity(identity, at);
    const runner = this.#runners.get(runnerId);
    if (!runner || runner.spiffeId !== identity.spiffeId || runner.certificateFingerprint !== identity.certificateFingerprint || runner.certificateSerial !== identity.certificateSerial) {
      throw new Error("Runner workload identity does not match the registered runner");
    }
    return runner;
  }

  #requireAttempt(attemptId: string): MatrixAttemptState {
    const attempt = this.#attempts.get(attemptId);
    if (!attempt) throw new Error("E2E attempt was not found");
    return attempt;
  }

  #replaceAttempt(current: MatrixAttemptState, changes: Partial<MatrixAttemptState>): MatrixAttemptState {
    const next = deepFreeze({ ...current, ...changes });
    this.#attempts.set(current.spec.attemptId, next);
    return next;
  }

  #buildEvidenceBundle(
    spec: MatrixAttemptSpec,
    platforms: Readonly<Partial<Record<TargetPlatform, PlatformLeaseState>>>,
    status: "PASSED" | "FAILED",
    at: string,
  ): EvidenceBundle {
    const evidence = spec.targetMatrix.map((platform) => platforms[platform]?.evidence);
    if (evidence.some((item) => !item)) throw new Error("Terminal matrix is missing platform evidence");
    const platformEvidence = evidence.map((item) => {
      const value = item as PlatformEvidenceManifest;
      return {
        platform: value.platform,
        runnerId: value.runnerId,
        runnerCapabilityDigest: value.runnerCapabilityDigest,
        exportDigest: value.exportDigest,
        logsDigest: value.logsDigest,
        junitDigest: value.junitDigest,
        inputTimelineDigest: value.inputTimelineDigest,
        screenshotManifestDigest: value.screenshotManifestDigest,
        videoManifestDigest: value.videoManifestDigest,
        status: value.status,
      };
    });
    const bundleCore = {
      id: `evidence-${spec.attemptId}`,
      attemptId: spec.attemptId,
      specRevisionId: spec.specRevisionId,
      specDigest: spec.specDigest,
      testPlanDigest: spec.testPlanDigest,
      commitSha: spec.commitSha,
      sourceDigest: spec.sourceDigest,
      targetMatrix: spec.targetMatrix,
      godotTestKitDigest: spec.godotTestKitDigest,
      buildManifestDigest: spec.buildManifestDigest,
      sbomDigest: spec.sbomDigest,
      vulnerabilityScanDigest: spec.vulnerabilityScanDigest,
      assetLicenseLedgerDigest: spec.assetLicenseLedgerDigest,
      platformEvidence,
      status,
      valid: true as const,
      createdAt: at,
    };
    return createEvidenceBundle({ ...bundleCore, bundleDigest: sha256Canonical(bundleCore) });
  }
}

export function verifyRunnerJob(
  job: SignedRunnerJob,
  publicKey: Parameters<typeof verifyCanonical>[0],
  expected: RunnerJobVerificationContext,
): boolean {
  return job.payload.schemaVersion === "deviludo.runner-job.v2"
    && job.signature.algorithm === "Ed25519"
    && job.signature.keyId === expected.keyId
    && job.payload.runnerId === expected.runnerId
    && job.payload.platform === expected.platform
    && job.payload.targetMatrix.includes(expected.platform)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(job.payload.executionLockId)
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(job.payload.runnerToolchainRevisionId)
    && [
      job.payload.executionLockDigest,
      job.payload.runnerToolchainDigest,
      job.payload.buildManifestDigest,
      job.payload.sbomDigest,
      job.payload.vulnerabilityScanDigest,
      job.payload.assetLicenseLedgerDigest,
    ].every((value) => /^[a-f0-9]{64}$/.test(value))
    && Number.isFinite(Date.parse(expected.now))
    && Number.isFinite(Date.parse(job.payload.leaseExpiresAt))
    && Date.parse(job.payload.leaseExpiresAt) >= Date.parse(expected.now)
    && validRunnerJobExecution(job.payload.execution)
    && sha256Canonical(job.payload.requiredEvidence) === sha256Canonical(REQUIRED_RUNNER_EVIDENCE)
    && verifyCanonical(publicKey, job.payload, job.signature.value);
}

function validRunnerJobExecution(value: RunnerJobPayload["execution"]): boolean {
  if (value.kind === "SOURCE_ARTIFACT") {
    return !!value.objectKey && !value.objectKey.startsWith("/") && !value.objectKey.includes("..")
      && /^[a-f0-9]{64}$/.test(value.artifactDigest);
  }
  return /^[1-9][0-9]{0,19}$/.test(value.steamAppId)
    && /^[1-9][0-9]{0,19}$/.test(value.buildId)
    && /^[a-z0-9][a-z0-9_-]{2,39}$/.test(value.betaBranch)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.installGrantId);
}

export function validateRunnerIdentity(identity: TlsRunnerIdentity, at: string): void {
  if (!identity.spiffeId.startsWith("spiffe://")) throw new Error("Runner SPIFFE identity is required");
  assertSha256(identity.certificateFingerprint, "certificateFingerprint");
  if (!identity.certificateSerial.trim()) throw new Error("Runner certificate serial is required");
  if (!Number.isFinite(Date.parse(at)) || !Number.isFinite(Date.parse(identity.certificateNotAfter)) || Date.parse(identity.certificateNotAfter) <= Date.parse(at)) {
    throw new Error("Runner certificate is expired or invalid");
  }
}

export function validateRunnerCapabilities(capabilities: RunnerCapabilities): void {
  const keys = Object.keys(capabilities).sort();
  const expectedKeys = [
    "runnerId", "platform", "architecture", "osVersion", "runnerImageDigest",
    "godotVersion", "godotBinaryDigest", "exportTemplatesDigest", "gpu",
    "display", "audio", "installedAutonomousAgents", "steamClientConnector", "capabilityDigest",
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Runner capability fields are invalid");
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(capabilities.runnerId)) throw new Error("Runner ID is invalid");
  if (!TARGET_PLATFORMS.includes(capabilities.platform)) throw new Error("Runner platform is invalid");
  if (capabilities.architecture !== "x86_64" && capabilities.architecture !== "arm64") {
    throw new Error("Runner architecture is invalid");
  }
  if (typeof capabilities.osVersion !== "string" || capabilities.osVersion.length < 1 || capabilities.osVersion.length > 160
    || typeof capabilities.godotVersion !== "string"
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){1,5}$/.test(capabilities.godotVersion)
    || typeof capabilities.gpu !== "string" || capabilities.gpu.length < 1 || capabilities.gpu.length > 160) {
    throw new Error("Runner capability metadata is incomplete");
  }
  if (capabilities.display !== "physical" && capabilities.display !== "virtual" && capabilities.display !== "headless") {
    throw new Error("Runner display capability is invalid");
  }
  if (capabilities.audio !== "physical" && capabilities.audio !== "virtual" && capabilities.audio !== "none") {
    throw new Error("Runner audio capability is invalid");
  }
  for (const [field, value] of Object.entries({
    runnerImageDigest: capabilities.runnerImageDigest,
    godotBinaryDigest: capabilities.godotBinaryDigest,
    exportTemplatesDigest: capabilities.exportTemplatesDigest,
    capabilityDigest: capabilities.capabilityDigest,
  })) assertSha256(value, field);
  if (!Array.isArray(capabilities.installedAutonomousAgents) || capabilities.installedAutonomousAgents.length) {
    throw new Error("Autonomous Agents are forbidden on E2E runners");
  }
  if (capabilities.steamClientConnector !== null) {
    const connector = capabilities.steamClientConnector;
    const keys = Object.keys(connector).sort();
    const expected = ["version", "bridgeVersion", "controllerContractVersion", "binaryDigest",
      "automationPolicyDigest", "supplyChainEvidenceDigest"].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || typeof connector.version !== "string"
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/.test(connector.version)
      || /(?:latest|stable|default)/i.test(connector.version)
      || typeof connector.bridgeVersion !== "string"
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+){0,5}$/.test(connector.bridgeVersion)
      || /(?:latest|stable|default)/i.test(connector.bridgeVersion)
      || connector.controllerContractVersion !== 1) {
      throw new Error("Steam Client Connector capability is invalid");
    }
    assertSha256(connector.binaryDigest, "steamClientConnector.binaryDigest");
    assertSha256(connector.automationPolicyDigest, "steamClientConnector.automationPolicyDigest");
    assertSha256(connector.supplyChainEvidenceDigest, "steamClientConnector.supplyChainEvidenceDigest");
  }
  const expected = immutableCapabilityDigest({ ...capabilities, capabilityDigest: "" });
  if (capabilities.capabilityDigest !== expected) throw new Error("Runner capability digest mismatch");
}

function validateAttemptSpec(spec: MatrixAttemptSpec): void {
  for (const value of [spec.attemptId, spec.tenantId, spec.projectId, spec.runId, spec.iterationId, spec.specRevisionId]) {
    if (!value.trim()) throw new Error("Attempt immutable binding is incomplete");
  }
  assertGitSha(spec.commitSha);
  for (const [field, value] of Object.entries({
    sourceDigest: spec.sourceDigest,
    executionLockDigest: spec.executionLockDigest,
    sourceArtifactDigest: spec.sourceArtifact.digest,
    specDigest: spec.specDigest,
    testPlanDigest: spec.testPlanDigest,
    runnerToolchainDigest: spec.runnerToolchainDigest,
    godotTestKitDigest: spec.godotTestKitDigest,
    buildManifestDigest: spec.buildManifestDigest,
    sbomDigest: spec.sbomDigest,
    vulnerabilityScanDigest: spec.vulnerabilityScanDigest,
    assetLicenseLedgerDigest: spec.assetLicenseLedgerDigest,
  })) assertSha256(value, field);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(spec.executionLockId)) {
    throw new Error("Runner execution lock ID is invalid");
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(spec.runnerToolchainRevisionId)) {
    throw new Error("Runner toolchain revision ID is invalid");
  }
  if (!spec.sourceArtifact.objectKey.trim() || spec.sourceArtifact.objectKey.startsWith("/") || spec.sourceArtifact.objectKey.includes("..")) throw new Error("Source artifact object key is invalid");
  const matrix = uniqueSorted(spec.targetMatrix);
  if (!matrix.length || matrix.some((platform) => !TARGET_PLATFORMS.includes(platform))) throw new Error("Target matrix is invalid");
  if (spec.targetMatrix.length !== matrix.length) throw new Error("Target matrix cannot contain duplicates");
  for (const platform of matrix) assertSha256(spec.exportTemplates[platform], `exportTemplates.${platform}`);
  if (!Number.isInteger(spec.leaseDurationSeconds) || spec.leaseDurationSeconds < 30 || spec.leaseDurationSeconds > 3_600) throw new Error("Lease duration must be between 30 and 3600 seconds");
}

function assertRunnerMatchesAttempt(runner: RegisteredRunner, spec: MatrixAttemptSpec): void {
  if (runner.godotVersion !== spec.requiredGodotVersion) throw new Error("Runner Godot version does not match the attempt lock");
  if (runner.exportTemplatesDigest !== spec.exportTemplates[runner.platform]) throw new Error("Runner export templates do not match the attempt lock");
}

type PlatformEvidenceAttemptBinding = Pick<MatrixAttemptSpec,
  | "attemptId" | "commitSha" | "sourceDigest" | "specRevisionId"
  | "specDigest" | "testPlanDigest" | "targetMatrix" | "godotTestKitDigest"
>;

export function validatePlatformEvidenceManifest(
  manifest: PlatformEvidenceManifest,
  spec: PlatformEvidenceAttemptBinding,
  runner: Pick<RegisteredRunner, "runnerId" | "platform" | "exportTemplatesDigest" | "capabilityDigest">,
  lease: PlatformRunnerLease,
): void {
  const keys = Object.keys(manifest).sort();
  const expectedKeys = [
    "schemaVersion", "attemptId", "fencingToken", "commitSha", "sourceDigest",
    "specRevisionId", "specDigest", "testPlanDigest", "targetMatrix",
    "godotTestKitDigest", "exportTemplatesDigest", "platform", "runnerId",
    "runnerCapabilityDigest", "exportDigest", "logsDigest", "junitDigest",
    "inputTimelineDigest", "screenshotManifestDigest", "videoManifestDigest",
    "status", "createdAt", "manifestDigest",
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Platform evidence manifest fields are invalid");
  }
  if (manifest.schemaVersion !== "deviludo.platform-evidence.v1"
    || manifest.attemptId !== spec.attemptId
    || manifest.runnerId !== runner.runnerId
    || manifest.platform !== runner.platform
    || manifest.fencingToken !== lease.fencingToken
    || manifest.commitSha !== spec.commitSha
    || manifest.sourceDigest !== spec.sourceDigest
    || manifest.specRevisionId !== spec.specRevisionId
    || manifest.specDigest !== spec.specDigest
    || manifest.testPlanDigest !== spec.testPlanDigest
    || manifest.godotTestKitDigest !== spec.godotTestKitDigest
    || manifest.exportTemplatesDigest !== runner.exportTemplatesDigest
    || manifest.runnerCapabilityDigest !== runner.capabilityDigest
  ) {
    throw new Error("Platform evidence manifest does not match the immutable lease");
  }
  if (sha256Canonical(manifest.targetMatrix) !== sha256Canonical(spec.targetMatrix)) throw new Error("Platform evidence target matrix mismatch");
  for (const [field, value] of Object.entries({
    logsDigest: manifest.logsDigest,
    junitDigest: manifest.junitDigest,
    inputTimelineDigest: manifest.inputTimelineDigest,
    screenshotManifestDigest: manifest.screenshotManifestDigest,
    videoManifestDigest: manifest.videoManifestDigest,
    exportDigest: manifest.exportDigest,
    exportTemplatesDigest: manifest.exportTemplatesDigest,
    manifestDigest: manifest.manifestDigest,
  })) assertSha256(value, field);
  const core: Record<string, unknown> = { ...manifest };
  delete core.manifestDigest;
  if (sha256Canonical(core) !== manifest.manifestDigest) throw new Error("Platform evidence manifest digest mismatch");
  if (!Number.isFinite(Date.parse(manifest.createdAt)) || Date.parse(manifest.createdAt) > Date.parse(lease.leaseExpiresAt)) throw new Error("Platform evidence was created outside the lease window");
}

function immutableCapabilityDigest(capabilities: Omit<RunnerCapabilities, "capabilityDigest"> | RunnerCapabilities | RegisteredRunner): string {
  return sha256Canonical({
    runnerId: capabilities.runnerId,
    platform: capabilities.platform,
    architecture: capabilities.architecture,
    osVersion: capabilities.osVersion,
    runnerImageDigest: capabilities.runnerImageDigest,
    godotVersion: capabilities.godotVersion,
    godotBinaryDigest: capabilities.godotBinaryDigest,
    exportTemplatesDigest: capabilities.exportTemplatesDigest,
    gpu: capabilities.gpu,
    display: capabilities.display,
    audio: capabilities.audio,
    installedAutonomousAgents: capabilities.installedAutonomousAgents,
    steamClientConnector: capabilities.steamClientConnector,
  });
}

export function createRunnerCapabilityDigest(capabilities: Omit<RunnerCapabilities, "capabilityDigest">): string {
  return immutableCapabilityDigest(capabilities);
}

export function createPlatformEvidenceManifest(
  input: Omit<PlatformEvidenceManifest, "manifestDigest">,
): PlatformEvidenceManifest {
  return deepFreeze({ ...input, manifestDigest: sha256Canonical(input) });
}

export function validateRunnerEventShape(event: RunnerEvent, cursor: RunnerEventCursor, receivedAt: string): void {
  const keys = Object.keys(event).sort();
  const expectedKeys = [
    "attemptId", "runnerId", "fencingToken", "seqNo", "commitSha",
    "sourceDigest", "platform", "type", "status", "artifactDigest", "occurredAt",
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Runner event fields are invalid");
  }
  if (!Number.isFinite(Date.parse(event.occurredAt)) || !Number.isFinite(Date.parse(receivedAt))) throw new Error("Runner event timestamp is invalid");
  if (Date.parse(event.occurredAt) > Date.parse(receivedAt) + 5 * 60_000) throw new Error("Runner event timestamp is too far in the future");
  if (cursor.lastAcceptedSeqNo === 0 && event.type !== "STARTED") throw new Error("The first platform event must be STARTED");
  if (cursor.lastAcceptedSeqNo > 0 && event.type === "STARTED") throw new Error("STARTED may appear only once per platform lease");
  if (event.type === "PLATFORM_COMPLETED" || event.type === "ATTEMPT_COMPLETED") {
    if (event.status === "RUNNING") throw new Error("Platform completion must be PASSED or FAILED");
  } else if (event.status !== "RUNNING") {
    throw new Error("Non-terminal runner events must remain RUNNING");
  }
  if (event.artifactDigest !== null) assertSha256(event.artifactDigest, "artifactDigest");
  if (["SCREENSHOT", "VIDEO", "JUNIT", "PLATFORM_COMPLETED"].includes(event.type) && !event.artifactDigest) {
    throw new Error(`${event.type} requires a content-addressed artifact digest`);
  }
}
