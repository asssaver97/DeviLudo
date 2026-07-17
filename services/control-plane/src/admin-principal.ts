import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  ADMIN_ROLES,
  ServiceProblem,
  type AdminMutationClaimBinding,
  type AdminRole,
  type RequestActor,
} from "./contracts";

const MAX_ASSERTION_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const authenticated = new WeakMap<FastifyRequest, RequestActor>();
const mutationClaims = new WeakMap<FastifyRequest, AdminMutationClaimBinding>();

export interface AdminPrincipalAssertion {
  readonly method: string;
  readonly path: string;
  readonly actorId: string;
  readonly role: AdminRole;
  readonly tenantId: string | null;
  readonly projectId: string | null;
  readonly sessionId: string;
  readonly issuedAt: string;
}

/** Used by the trusted ingress/auth proxy, never by a browser. */
export function createAdminPrincipalSignature(
  assertion: AdminPrincipalAssertion,
  key: Uint8Array,
): string {
  if (key.byteLength < 32) throw new Error("Admin session signing key must contain at least 32 bytes");
  return createHmac("sha256", key).update(canonicalAssertion(assertion)).digest("base64url");
}

export function authenticateAdminPrincipal(
  request: FastifyRequest,
  now: Date = new Date(),
): RequestActor {
  const existing = authenticated.get(request);
  if (existing) return existing;
  const role = requestHeader(request, "x-deviludo-role");
  const actorId = requestHeader(request, "x-deviludo-actor");
  const tenantId = optionalHeader(request, "x-deviludo-tenant-id");
  const projectId = optionalHeader(request, "x-deviludo-project-id");
  const sessionId = requestHeader(request, "x-deviludo-admin-session");
  const issuedAt = requestHeader(request, "x-deviludo-admin-issued-at");
  const signature = requestHeader(request, "x-deviludo-admin-signature");
  if (!role || !ADMIN_ROLES.includes(role as AdminRole) || !actorId || !SAFE_SUBJECT.test(actorId)
    || !sessionId || !SAFE_SUBJECT.test(sessionId) || !issuedAt || !signature) unauthorized();
  if ((tenantId && !SAFE_SCOPE.test(tenantId)) || (projectId && !SAFE_SCOPE.test(projectId))) unauthorized();
  validateRoleScope(role as AdminRole, tenantId, projectId);
  const issuedAtMs = Date.parse(issuedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(issuedAtMs)
    || issuedAtMs < nowMs - MAX_ASSERTION_AGE_MS || issuedAtMs > nowMs + MAX_FUTURE_SKEW_MS) unauthorized();
  const assertion: AdminPrincipalAssertion = Object.freeze({
    method: request.method.toUpperCase(),
    path: request.raw.url ?? request.url,
    actorId,
    role: role as AdminRole,
    tenantId,
    projectId,
    sessionId,
    issuedAt,
  });
  const key = adminSessionKey();
  const expected = createAdminPrincipalSignature(assertion, key);
  const suppliedBytes = Buffer.from(signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) unauthorized();
  const actor: RequestActor = Object.freeze({
    role: assertion.role,
    actorId: assertion.actorId,
    tenantId: assertion.tenantId,
    projectId: assertion.projectId,
    requestId: request.id,
  });
  authenticated.set(request, actor);
  return actor;
}

export function authenticatedAdminActor(request: FastifyRequest): RequestActor {
  return authenticated.get(request) ?? authenticateAdminPrincipal(request);
}

export function bindAdminMutationClaim(
  request: FastifyRequest,
  claim: AdminMutationClaimBinding,
): void {
  if (!/^[a-f0-9]{64}$/.test(claim.identityDigest)
    || !/^[a-f0-9]{64}$/.test(claim.requestFingerprint)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(claim.claimToken)
    || mutationClaims.has(request)) {
    throw new Error("Administrator mutation claim binding is invalid");
  }
  mutationClaims.set(request, Object.freeze({ ...claim }));
}

export function authenticatedAdminMutationActor(request: FastifyRequest): RequestActor {
  const actor = authenticatedAdminActor(request);
  const mutation = mutationClaims.get(request);
  return mutation ? Object.freeze({ ...actor, mutation }) : actor;
}

function canonicalAssertion(value: AdminPrincipalAssertion): string {
  return [
    "deviludo.admin-principal.v1",
    value.method.toUpperCase(),
    value.path,
    value.actorId,
    value.role,
    value.tenantId ?? "",
    value.projectId ?? "",
    value.sessionId,
    value.issuedAt,
  ].join("\n");
}

function adminSessionKey(): Uint8Array {
  const encoded = process.env.DEVILUDO_ADMIN_SESSION_HMAC_KEY;
  if (!encoded) throw new ServiceProblem(503, "ADMIN_AUTH_UNAVAILABLE", "Administrator authentication is unavailable");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength < 32) throw new ServiceProblem(503, "ADMIN_AUTH_UNAVAILABLE", "Administrator authentication is unavailable");
  return key;
}

function optionalHeader(request: FastifyRequest, name: string): string | null {
  const value = requestHeader(request, name);
  return value?.trim() ? value.trim() : null;
}

function requestHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function validateRoleScope(role: AdminRole, tenantId: string | null, projectId: string | null): void {
  if ((role === "PlatformAgentAdmin" || role === "SecurityAdmin") && (tenantId || projectId)) unauthorized();
  if (role === "TenantAdmin" && (!tenantId || projectId)) unauthorized();
  if (role === "ProjectOwner" && (!tenantId || !projectId)) unauthorized();
  if (projectId && !tenantId) unauthorized();
}

function unauthorized(): never {
  throw new ServiceProblem(401, "ADMIN_SESSION_INVALID", "A valid administrator session assertion is required");
}
