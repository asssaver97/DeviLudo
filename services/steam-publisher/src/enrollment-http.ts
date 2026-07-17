import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  SteamEnrollmentPrincipal,
  SteamEnrollmentView,
} from "./enrollment-contracts";

export interface SteamEnrollmentBrokerPort {
  begin(principal: SteamEnrollmentPrincipal, idempotencyKey: string): Promise<SteamEnrollmentView>;
}

export function registerSteamEnrollmentBrokerRoutes(
  server: FastifyInstance,
  options: {
    readonly broker: SteamEnrollmentBrokerPort;
    /** Authenticates the Web/control-plane workload over mTLS. */
    readonly authorize: (request: FastifyRequest) => void | Promise<void>;
  },
): void {
  server.post("/v1/steam/enrollments", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    secureHeaders(reply);
    try {
      await options.authorize(request);
    } catch {
      return reply.status(401).send({
        error: { code: "WORKLOAD_IDENTITY_REQUIRED", message: "Authorized Web workload identity is required" },
      });
    }
    try {
      const body = requireExactObject(request.body, ["principal"], "Steam enrollment body");
      const principal = requirePrincipal(body.principal);
      const result = await options.broker.begin(principal, requireIdempotencyKey(request));
      return reply.status(result.state === "READY" ? 200 : 201).send(result);
    } catch (error) {
      const conflict = error instanceof Error && error.message.includes("idempotency key conflicts");
      return reply.status(conflict ? 409 : 400).send({
        error: {
          code: conflict ? "IDEMPOTENCY_CONFLICT" : "STEAM_ENROLLMENT_REJECTED",
          message: conflict ? "Idempotency key conflicts with another request" : "Steam enrollment request was rejected",
        },
      });
    }
  });
}

function requirePrincipal(value: unknown): SteamEnrollmentPrincipal {
  const body = requireExactObject(value, ["tenantId", "userId", "sessionBinding"], "Steam enrollment principal");
  const tenantId = requireOpaqueId(body.tenantId, "tenant");
  const userId = requireOpaqueId(body.userId, "user");
  const sessionBinding = body.sessionBinding;
  if (typeof sessionBinding !== "string" || sessionBinding.length < 32 || sessionBinding.length > 512
    || /[\u0000-\u001f\u007f]/.test(sessionBinding)) {
    throw new Error("Steam enrollment session binding is invalid");
  }
  return Object.freeze({ tenantId, userId, sessionBinding });
}

function requireExactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const body = value as Record<string, unknown>;
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unsupported fields`);
  }
  return body;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(`Steam ${label} ID is invalid`);
  }
  return value;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error("Steam enrollment idempotency key is invalid");
  }
  return value;
}

function secureHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
  reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
}
