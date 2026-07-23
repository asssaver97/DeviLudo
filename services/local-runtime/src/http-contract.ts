import type {
  LocalExternalApprovalRequest,
  LocalMainGateRequest,
  LocalRuntimeRequest,
  LocalSteamReinstallRequest,
} from "./contracts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const TARGET_PLATFORMS = new Set(["linux", "windows", "macos"]);
const BINDING_KEYS = ["projectId", "runId", "specRevisionId", "targetMatrix"];
const REQUEST_KEYS = [...BINDING_KEYS, "sourceAuthority"];
const MAIN_GATE_REQUEST_KEYS = [
  ...BINDING_KEYS,
  "candidateEvidenceId",
  "candidateBundleDigest",
  "candidateSha",
  "sourceDigest",
];
const STEAM_REINSTALL_REQUEST_KEYS = [
  ...BINDING_KEYS,
  "mainEvidenceId",
  "mainBundleDigest",
  "mainSha",
  "mainSourceDigest",
  "mainArtifactSha256",
  "mfaApprovalId",
];
const EXTERNAL_APPROVAL_REQUEST_KEYS = [
  ...BINDING_KEYS,
  "mainSha",
  "steamBuildId",
  "steamReinstallEvidenceId",
  "steamReinstallBundleDigest",
  "gate",
  "sequence",
  "previousApprovalEvidenceId",
];

export class LocalRuntimeRequestError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: "INVALID_REQUEST" | "RUN_BINDING_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

export function parseLocalRuntimeRequest(rawBody: Buffer): LocalRuntimeRequest {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", "Local runtime request must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", "Local runtime request must be a JSON object");
  }

  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...REQUEST_KEYS].sort())
    || !validIdentifier(body.projectId)
    || !validIdentifier(body.runId)
    || !validIdentifier(body.specRevisionId)
    || !validTargetMatrix(body.targetMatrix)
    || !validSourceAuthority(body.sourceAuthority)) {
    throw new LocalRuntimeRequestError(
      400,
      "INVALID_REQUEST",
      "projectId, runId, specRevisionId, sourceAuthority and a unique 1-3 platform targetMatrix are required",
    );
  }
  return body as LocalRuntimeRequest;
}

export function parseLocalMainGateRequest(rawBody: Buffer): LocalMainGateRequest {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", "Local main gate request must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", "Local main gate request must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...MAIN_GATE_REQUEST_KEYS].sort())
    || !validIdentifier(body.projectId)
    || !validIdentifier(body.runId)
    || !validIdentifier(body.specRevisionId)
    || !validTargetMatrix(body.targetMatrix)
    || body.targetMatrix.length !== 1
    || body.targetMatrix[0] !== "macos"
    || typeof body.candidateEvidenceId !== "string"
    || !/^EV-LOCAL-[A-F0-9]{12}$/.test(body.candidateEvidenceId)
    || typeof body.candidateBundleDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(body.candidateBundleDigest)
    || typeof body.candidateSha !== "string"
    || !/^[a-f0-9]{40}$/.test(body.candidateSha)
    || typeof body.sourceDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(body.sourceDigest)) {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", "Local main gate request requires one exact accepted candidate evidence binding");
  }
  return body as LocalMainGateRequest;
}

export function parseLocalSteamReinstallRequest(rawBody: Buffer): LocalSteamReinstallRequest {
  const body = parseObject(rawBody, "Local Steam reinstall request");
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...STEAM_REINSTALL_REQUEST_KEYS].sort())
    || !validIdentifier(body.projectId)
    || !validIdentifier(body.runId)
    || !validIdentifier(body.specRevisionId)
    || !validTargetMatrix(body.targetMatrix)
    || body.targetMatrix.length !== 1
    || body.targetMatrix[0] !== "macos"
    || typeof body.mainEvidenceId !== "string"
    || !/^EV-MAIN-[A-F0-9]{12}$/.test(body.mainEvidenceId)
    || typeof body.mainBundleDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(body.mainBundleDigest)
    || typeof body.mainSha !== "string"
    || !/^[a-f0-9]{40}$/.test(body.mainSha)
    || typeof body.mainSourceDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(body.mainSourceDigest)
    || typeof body.mainArtifactSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(body.mainArtifactSha256)
    || typeof body.mfaApprovalId !== "string"
    || !/^MFA-LOCAL-[0-9]{4,}$/.test(body.mfaApprovalId)) {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", "Local Steam reinstall request requires an exact main, artifact and MFA binding");
  }
  return body as LocalSteamReinstallRequest;
}

export function parseLocalExternalApprovalRequest(rawBody: Buffer): LocalExternalApprovalRequest {
  const body = parseObject(rawBody, "Local external approval request");
  const expectedGate = ["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"][Number(body.sequence) - 1];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...EXTERNAL_APPROVAL_REQUEST_KEYS].sort())
    || !validIdentifier(body.projectId)
    || !validIdentifier(body.runId)
    || !validIdentifier(body.specRevisionId)
    || !validTargetMatrix(body.targetMatrix)
    || body.targetMatrix.length !== 1
    || body.targetMatrix[0] !== "macos"
    || typeof body.mainSha !== "string" || !/^[a-f0-9]{40}$/.test(body.mainSha)
    || typeof body.steamBuildId !== "string" || !/^BUILD-LOCAL-[A-F0-9]{12}$/.test(body.steamBuildId)
    || typeof body.steamReinstallEvidenceId !== "string" || !/^EV-STEAM-[A-F0-9]{12}$/.test(body.steamReinstallEvidenceId)
    || typeof body.steamReinstallBundleDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.steamReinstallBundleDigest)
    || !Number.isInteger(body.sequence) || Number(body.sequence) < 1 || Number(body.sequence) > 3
    || body.gate !== expectedGate
    || (body.sequence === 1 ? body.previousApprovalEvidenceId !== null
      : typeof body.previousApprovalEvidenceId !== "string" || !/^EV-APPROVAL-[A-F0-9]{12}$/.test(body.previousApprovalEvidenceId))) {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", "Local external approval request requires the exact ordered release authority binding");
  }
  return body as LocalExternalApprovalRequest;
}

export function localRuntimeRunBinding(request: LocalRuntimeRequest) {
  return JSON.stringify([
    request.projectId,
    request.runId,
    request.specRevisionId,
    ...request.targetMatrix,
    request.sourceAuthority,
  ]);
}

export class LocalRuntimeRunCoordinator<Result> {
  readonly #running = new Map<string, { binding: string; operation: Promise<Result> }>();

  start(request: LocalRuntimeRequest, execute: () => Promise<Result>): Promise<Result> {
    const key = `${request.projectId}:${request.runId}`;
    const binding = localRuntimeRunBinding(request);
    const active = this.#running.get(key);
    if (active && active.binding !== binding) {
      throw new LocalRuntimeRequestError(
        409,
        "RUN_BINDING_CONFLICT",
        "An active local run already owns this projectId and runId with a different immutable binding",
      );
    }
    if (active) return active.operation;

    const operation = execute().finally(() => {
      if (this.#running.get(key)?.operation === operation) this.#running.delete(key);
    });
    this.#running.set(key, { binding, operation });
    return operation;
  }
}

export class LocalMainGateCoordinator<Result> {
  readonly #running = new Map<string, { binding: string; operation: Promise<Result> }>();

  start(request: LocalMainGateRequest, execute: () => Promise<Result>): Promise<Result> {
    const key = `${request.projectId}:${request.runId}:main`;
    const binding = JSON.stringify([
      request.projectId,
      request.runId,
      request.specRevisionId,
      ...request.targetMatrix,
      request.candidateEvidenceId,
      request.candidateBundleDigest,
      request.candidateSha,
      request.sourceDigest,
    ]);
    const active = this.#running.get(key);
    if (active && active.binding !== binding) {
      throw new LocalRuntimeRequestError(409, "RUN_BINDING_CONFLICT", "An active main gate already owns a different accepted candidate binding");
    }
    if (active) return active.operation;
    const operation = execute().finally(() => {
      if (this.#running.get(key)?.operation === operation) this.#running.delete(key);
    });
    this.#running.set(key, { binding, operation });
    return operation;
  }
}

export class LocalSteamReinstallCoordinator<Result> {
  readonly #running = new Map<string, { binding: string; operation: Promise<Result> }>();

  start(request: LocalSteamReinstallRequest, execute: () => Promise<Result>): Promise<Result> {
    const key = `${request.projectId}:${request.runId}:steam-reinstall`;
    const binding = JSON.stringify([
      request.projectId,
      request.runId,
      request.specRevisionId,
      ...request.targetMatrix,
      request.mainEvidenceId,
      request.mainBundleDigest,
      request.mainSha,
      request.mainSourceDigest,
      request.mainArtifactSha256,
      request.mfaApprovalId,
    ]);
    const active = this.#running.get(key);
    if (active && active.binding !== binding) {
      throw new LocalRuntimeRequestError(409, "RUN_BINDING_CONFLICT", "An active local Steam reinstall owns a different immutable binding");
    }
    if (active) return active.operation;
    const operation = execute().finally(() => {
      if (this.#running.get(key)?.operation === operation) this.#running.delete(key);
    });
    this.#running.set(key, { binding, operation });
    return operation;
  }
}

export class LocalExternalApprovalCoordinator<Result> {
  readonly #running = new Map<string, { binding: string; operation: Promise<Result> }>();

  start(request: LocalExternalApprovalRequest, execute: () => Promise<Result>): Promise<Result> {
    const key = `${request.projectId}:${request.runId}:approval:${request.sequence}`;
    const binding = JSON.stringify([
      request.projectId, request.runId, request.specRevisionId, ...request.targetMatrix,
      request.mainSha, request.steamBuildId, request.steamReinstallEvidenceId,
      request.steamReinstallBundleDigest, request.gate, request.sequence, request.previousApprovalEvidenceId,
    ]);
    const active = this.#running.get(key);
    if (active && active.binding !== binding) {
      throw new LocalRuntimeRequestError(409, "RUN_BINDING_CONFLICT", "An active local external approval owns a different immutable binding");
    }
    if (active) return active.operation;
    const operation = execute().finally(() => {
      if (this.#running.get(key)?.operation === operation) this.#running.delete(key);
    });
    this.#running.set(key, { binding, operation });
    return operation;
  }
}

function parseObject(rawBody: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", `${label} must contain valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalRuntimeRequestError(400, "INVALID_REQUEST", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validTargetMatrix(value: unknown): value is LocalRuntimeRequest["targetMatrix"] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 3
    && new Set(value).size === value.length
    && value.every((platform) => typeof platform === "string" && TARGET_PLATFORMS.has(platform));
}

function validSourceAuthority(value: unknown): value is LocalRuntimeRequest["sourceAuthority"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.kind === "FIXTURE") {
    return exactKeys(item, ["kind", "fixtureId", "attemptId"])
      && item.fixtureId === "godot-smoke-v1"
      && item.attemptId === "fixture-attempt-1";
  }
  return item.kind === "AGENT_CANDIDATE"
    && exactKeys(item, ["kind", "attemptId", "branch", "baseCommitSha", "candidateSha", "sourceDigest"])
    && validIdentifier(item.attemptId)
    && typeof item.branch === "string"
    && validCandidateBranch(item.branch)
    && typeof item.baseCommitSha === "string" && /^[a-f0-9]{40}$/.test(item.baseCommitSha)
    && typeof item.candidateSha === "string" && /^[a-f0-9]{40}$/.test(item.candidateSha)
    && item.candidateSha !== item.baseCommitSha
    && typeof item.sourceDigest === "string" && /^[a-f0-9]{64}$/.test(item.sourceDigest);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validCandidateBranch(value: string): boolean {
  return value.length <= 128
    && /^deviludo\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(value)
    && !value.includes("..")
    && !value.endsWith(".lock");
}
