import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SteamEnrollmentPrincipal } from "./enrollment-contracts";
import type {
  SteamPlatformDepots,
  SteamProjectConfigurationBrokerPort,
  SteamProjectConfigurationInteractivePort,
} from "./project-configuration-contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function registerSteamProjectConfigurationRoutes(server: FastifyInstance, options: Readonly<{
  broker: SteamProjectConfigurationBrokerPort;
  authorize: (request: FastifyRequest) => void | Promise<void>;
  interactive?: SteamProjectConfigurationInteractivePort;
  authorizeInteractive?: (request: FastifyRequest, intentId: string, projectId: string) => SteamEnrollmentPrincipal | Promise<SteamEnrollmentPrincipal>;
}>): void {
  server.post("/v1/steam/project-configurations/status", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    secure(reply);
    try { await options.authorize(request); }
    catch { return problem(reply, 401, "WORKLOAD_IDENTITY_REQUIRED"); }
    try {
      const body = exact(request.body, ["principal", "projectId"]);
      return reply.send(await options.broker.status(principal(body.principal), uuid(body.projectId)));
    } catch { return problem(reply, 400, "STEAM_PROJECT_CONFIGURATION_STATUS_REJECTED"); }
  });

  server.post("/v1/steam/project-configurations", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    secure(reply);
    try { await options.authorize(request); }
    catch { return problem(reply, 401, "WORKLOAD_IDENTITY_REQUIRED"); }
    try {
      const body = exact(request.body, ["principal", "projectId"]);
      const result = await options.broker.begin(principal(body.principal), uuid(body.projectId), idempotency(request));
      return reply.status(result.state === "READY" ? 200 : 201).send(result);
    } catch (error) {
      const conflict = error instanceof Error && error.message.includes("idempotency key conflicts");
      return problem(reply, conflict ? 409 : 400, conflict ? "IDEMPOTENCY_CONFLICT" : "STEAM_PROJECT_CONFIGURATION_REJECTED");
    }
  });

  if (!options.interactive || !options.authorizeInteractive) return;
  if (!server.hasContentTypeParser("application/octet-stream")) {
    server.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 128 }, (_request, body, done) => done(null, body));
  }
  server.post("/v1/steam/project-configurations/:intentId/complete", {
    bodyLimit: 64,
    onRequest: binaryOnly,
  }, async (request, reply) => {
    secure(reply);
    const password = bytes(request.body);
    try {
      let intentId: string;
      let projectId: string;
      let authorized: SteamEnrollmentPrincipal;
      try {
        intentId = uuid((request.params as Record<string, unknown>).intentId);
        projectId = uuid(request.headers["x-deviludo-project-id"]);
        authorized = await options.authorizeInteractive!(request, intentId, projectId);
      } catch { return problem(reply, 401, "STEAM_PROJECT_CONFIGURATION_UI_SESSION_REQUIRED"); }
      if (!password || password.byteLength < 8 || password.byteLength > 64) return problem(reply, 400, "STEAM_PROJECT_CONFIGURATION_REJECTED");
      try {
        const result = await options.interactive!.completeConfiguration({ principal: authorized, projectId, intentId,
          steamAppId: numeric(request.headers["x-steam-app-id"]), betaBranch: branch(request.headers["x-steam-beta-branch"]),
          platformDepots: depotHeaders(request), branchPassword: password });
        return reply.send(result);
      } catch { return problem(reply, 400, "STEAM_PROJECT_CONFIGURATION_REJECTED"); }
    } finally { password?.fill(0); }
  });
}

function principal(value: unknown): SteamEnrollmentPrincipal {
  const body = exact(value, ["tenantId", "userId", "sessionBinding"]);
  if (typeof body.tenantId !== "string" || !ID.test(body.tenantId) || typeof body.userId !== "string" || !ID.test(body.userId)
    || typeof body.sessionBinding !== "string" || body.sessionBinding.length < 32 || body.sessionBinding.length > 512
    || /[\u0000-\u001f\u007f]/.test(body.sessionBinding)) throw new Error("principal invalid");
  return Object.freeze({ tenantId: body.tenantId, userId: body.userId, sessionBinding: body.sessionBinding });
}
function depotHeaders(request: FastifyRequest): SteamPlatformDepots {
  const result: Partial<Record<"windows" | "linux" | "macos", string>> = {};
  for (const platform of ["windows", "linux", "macos"] as const) {
    const value = request.headers[`x-steam-depot-${platform}`];
    if (value !== undefined) result[platform] = numeric(value);
  }
  if (!Object.keys(result).length) throw new Error("depots invalid");
  return Object.freeze(result);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body invalid");
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) throw new Error("body fields invalid");
  return body;
}
function uuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) throw new Error("uuid invalid"); return value; }
function numeric(value: unknown): string { if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) throw new Error("numeric id invalid"); return value; }
function branch(value: unknown): string { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(value)
  || value === "default" || value === "public") throw new Error("branch invalid"); return value; }
function idempotency(request: FastifyRequest): string { const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !ID.test(value)) throw new Error("idempotency invalid"); return value; }
function bytes(value: unknown): Uint8Array | null { return Buffer.isBuffer(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null; }
async function binaryOnly(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.headers["content-type"] !== "application/octet-stream") {
    secure(reply); await reply.status(415).send({ error: { code: "BINARY_SECRET_BODY_REQUIRED", message: "Binary secret body required" } });
  }
}
function secure(reply: FastifyReply): void { reply.header("cache-control", "no-store"); reply.header("x-content-type-options", "nosniff");
  reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'"); }
function problem(reply: FastifyReply, status: number, code: string) { return reply.status(status).send({ error: { code, message: "Steam project configuration request was rejected" } }); }
