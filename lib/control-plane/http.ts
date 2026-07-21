export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpProblem(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpProblem(400, "INVALID_JSON", "Request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpProblem(400, "INVALID_BODY", "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, field: string, max = 2000): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new HttpProblem(400, "INVALID_FIELD", `${field} must be a non-empty string no longer than ${max} characters`, { field });
  }
  return value.trim();
}

export function assertAllowedBodyFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowList = new Set(allowed);
  if (Object.keys(body).some((field) => !allowList.has(field))) {
    throw new HttpProblem(
      400,
      "UNEXPECTED_FIELD",
      "Request body contains a field that is not part of this operation contract",
    );
  }
}

export function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || value.length > 160) {
    throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  }
  return value;
}

export function requestRole(request: Request): string {
  return request.headers.get("x-deviludo-role") ?? "Auditor";
}

export function requireRole(request: Request, allowed: readonly string[]): string {
  const role = requestRole(request);
  if (!allowed.includes(role)) {
    throw new HttpProblem(403, "FORBIDDEN", `Role ${role} cannot perform this action`, { allowed });
  }
  return role;
}

export function problemResponse(error: unknown): Response {
  if (error instanceof HttpProblem) {
    return json({ error: { code: error.code, message: error.message, details: error.details ?? null } }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return json({ error: { code: "INTERNAL_ERROR", message } }, { status: 500 });
}
