import type { LocalRuntimeRequest } from "./contracts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const TARGET_PLATFORMS = new Set(["linux", "windows", "macos"]);
const REQUEST_KEYS = ["projectId", "runId", "specRevisionId", "targetMatrix"];

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
    || !validTargetMatrix(body.targetMatrix)) {
    throw new LocalRuntimeRequestError(
      400,
      "INVALID_REQUEST",
      "projectId, runId, specRevisionId and a unique 1-3 platform targetMatrix are required",
    );
  }
  return body as LocalRuntimeRequest;
}

export function localRuntimeRunBinding(request: LocalRuntimeRequest) {
  return JSON.stringify([
    request.projectId,
    request.runId,
    request.specRevisionId,
    ...request.targetMatrix,
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
