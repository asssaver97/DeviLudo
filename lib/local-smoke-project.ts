const EPHEMERAL_SMOKE_PROJECT = /^smoke-(?:spec|validation|feedback|release-gates|codex-release)-[1-9][0-9]{0,9}-[a-z0-9]{6,16}$/;
const EPHEMERAL_SMOKE_RUN = /^smoke-(?:spec|validation|feedback|release-gates|codex-release)-([1-9][0-9]{0,9}-[a-z0-9]{6,16})$/;
const PERSISTENT_SMOKE_PROJECT = "smoke-local-project";
const MAX_CLEANUP_PROJECTS = 20;

export function isEphemeralSmokeProjectId(value: unknown): value is string {
  return typeof value === "string" && EPHEMERAL_SMOKE_PROJECT.test(value);
}

export function isManagedSmokeProjectId(value: unknown): value is string {
  return value === PERSISTENT_SMOKE_PROJECT || isEphemeralSmokeProjectId(value);
}

export function localSmokeRunId(value: unknown): string | null {
  return typeof value === "string" ? EPHEMERAL_SMOKE_RUN.exec(value)?.[1] ?? null : null;
}

/**
 * Parses the authenticated local cleanup envelope. This intentionally accepts
 * only platform-generated smoke identities; a user-created project can never
 * be selected by a prefix, wildcard, path, age, or caller-provided directory.
 */
export function parseLocalSmokeCleanupRequest(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Array.isArray(body.projectIds)
    || body.projectIds.length < 1 || body.projectIds.length > MAX_CLEANUP_PROJECTS) invalid();
  const projectIds = body.projectIds;
  if (projectIds.some((projectId) => !isManagedSmokeProjectId(projectId))) invalid();
  if (new Set(projectIds).size !== projectIds.length) invalid();
  return Object.freeze([...projectIds] as string[]);
}

function invalid(): never {
  throw new Error("Local smoke cleanup request is invalid");
}
