import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PlatformRole } from "./contracts";
import type { PlatformIdentityBroker } from "./broker";

export function registerIdentityRoutes(server: FastifyInstance, options: {
  readonly broker: PlatformIdentityBroker;
  readonly authorizeWeb: (request: FastifyRequest) => void | Promise<void>;
  readonly authorizeAdmin: (request: FastifyRequest) => void | Promise<void>;
}): void {
  server.post("/v1/invitations", async (request, reply) => {
    secure(reply);
    try { await options.authorizeAdmin(request); }
    catch { return reply.status(401).send(error("WORKLOAD_IDENTITY_REQUIRED", "Authorized identity administration workload is required")); }
    try {
      const body = object(request.body);
      exact(body, ["createdBy", "expiresAt", "role", "tenantId"]);
      const result = await options.broker.createInvitation({ tenantId: uuid(body.tenantId), role: role(body.role),
        expiresAt: iso(body.expiresAt), createdBy: opaque(body.createdBy, 160) });
      return reply.status(201).send(result);
    } catch { return reply.status(400).send(error("INVITATION_REJECTED", "Invitation request was rejected")); }
  });

  server.post("/v1/auth/github/begin", async (request, reply) => {
    secure(reply);
    if (!await webAuthorized(options.authorizeWeb, request, reply)) return;
    try {
      const body = object(request.body); exact(body, ["browserBinding", "invitationToken"]);
      return reply.status(201).send(await options.broker.begin({
        invitationToken: locator(body.invitationToken), browserBinding: random(body.browserBinding),
      }));
    } catch { return reply.status(400).send(error("LOGIN_BEGIN_REJECTED", "Login invitation is invalid or unavailable")); }
  });

  server.post("/v1/auth/github/complete", async (request, reply) => {
    secure(reply);
    if (!await webAuthorized(options.authorizeWeb, request, reply)) return;
    try {
      const body = object(request.body); exact(body, ["browserBinding", "code", "state"]);
      return reply.send(await options.broker.complete({ state: locator(body.state), code: code(body.code),
        browserBinding: random(body.browserBinding) }));
    } catch { return reply.status(400).send(error("LOGIN_COMPLETE_REJECTED", "GitHub login could not be completed")); }
  });

  server.post("/v1/sessions/assert", async (request, reply) => {
    secure(reply);
    if (!await webAuthorized(options.authorizeWeb, request, reply)) return;
    try {
      const body = object(request.body); exact(body, ["browserBinding", "method", "pathname", "sessionToken"]);
      return reply.send(await options.broker.assertSession({ sessionToken: locator(body.sessionToken),
        browserBinding: random(body.browserBinding), method: method(body.method), pathname: pathname(body.pathname) }));
    } catch { return reply.status(401).send(error("SESSION_REJECTED", "Platform session is invalid or expired")); }
  });

  server.post("/v1/sessions/revoke", async (request, reply) => {
    secure(reply);
    if (!await webAuthorized(options.authorizeWeb, request, reply)) return;
    try {
      const body = object(request.body); exact(body, ["browserBinding", "sessionToken"]);
      await options.broker.revokeSession({ sessionToken: locator(body.sessionToken), browserBinding: random(body.browserBinding) });
      return reply.status(204).send();
    } catch { return reply.status(204).send(); }
  });
}

async function webAuthorized(authorize: (request: FastifyRequest) => void | Promise<void>, request: FastifyRequest,
  reply: { status(code: number): { send(value: unknown): unknown } }): Promise<boolean> {
  try { await authorize(request); return true; }
  catch { reply.status(401).send(error("WORKLOAD_IDENTITY_REQUIRED", "Authorized Web workload identity is required")); return false; }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[]): void { if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(); }
function uuid(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error(); return value; }
function locator(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(value)) throw new Error(); return value; }
function random(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error(); return value; }
function role(value: unknown): PlatformRole { if (value !== "TenantAdmin" && value !== "ProjectOwner" && value !== "Auditor") throw new Error(); return value; }
function iso(value: unknown): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(); return new Date(value).toISOString(); }
function opaque(value: unknown, maximum: number): string { if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(); return value; }
function code(value: unknown): string { const result = opaque(value, 512); if (/[\u0000-\u0020]/.test(result)) throw new Error(); return result; }
function method(value: unknown): string { if (typeof value !== "string" || !/^(?:GET|POST|PUT|PATCH|DELETE)$/.test(value.toUpperCase())) throw new Error(); return value.toUpperCase(); }
function pathname(value: unknown): string { if (typeof value !== "string" || !value.startsWith("/api/") || value.length > 1_024 || value.includes("?") || value.includes("#") || /[\u0000-\u001f\\]/.test(value)) throw new Error(); return value; }
function error(code: string, message: string): { error: { code: string; message: string } } { return { error: { code, message } }; }
function secure(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store"); reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff"); reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
}
