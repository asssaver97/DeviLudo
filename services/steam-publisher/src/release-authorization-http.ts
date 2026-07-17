import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ReleaseAuthorizationPrincipal,
  ReleaseAuthorizationView,
} from "./release-authorization-contracts";

export interface ReleaseAuthorizationBrokerPort {
  begin(
    principal: ReleaseAuthorizationPrincipal,
    releaseId: string,
    idempotencyKey: string,
  ): Promise<ReleaseAuthorizationView>;
  complete(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly approvalId: string;
    readonly assertion: unknown;
  }): Promise<ReleaseAuthorizationView>;
}

export function registerReleaseAuthorizationBrokerRoutes(
  server: FastifyInstance,
  options: {
    readonly broker: ReleaseAuthorizationBrokerPort;
    /** Authenticates the Web workload over mTLS. */
    readonly authorizeInternal: (request: FastifyRequest) => void | Promise<void>;
    /** Validates the broker UI's HttpOnly session, Origin and CSRF token. */
    readonly authorizeMfaCompletion: (request: FastifyRequest, approvalId: string) => {
      readonly tenantId: string;
      readonly userId: string;
    } | Promise<{ readonly tenantId: string; readonly userId: string }>;
  },
): void {
  server.post("/v1/releases/:releaseId/accept-and-publish", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    secureHeaders(reply);
    try {
      await options.authorizeInternal(request);
    } catch {
      return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED", message: "Authorized Web workload identity is required" } });
    }
    try {
      const releaseId = requireOpaqueId((request.params as Record<string, unknown>).releaseId, "release");
      const body = requireExactObject(request.body, ["principal"], "Release authorization body");
      const principal = requirePrincipal(body.principal);
      const result = await options.broker.begin(principal, releaseId, requireIdempotencyKey(request));
      return reply.status(result.state === "DISPATCHED" ? 200 : 201).send(result);
    } catch (error) {
      const conflict = error instanceof Error && error.message.includes("idempotency key conflicts");
      return reply.status(conflict ? 409 : 400).send({
        error: {
          code: conflict ? "IDEMPOTENCY_CONFLICT" : "RELEASE_AUTHORIZATION_REJECTED",
          message: conflict ? "Idempotency key conflicts with another request" : "Release authorization request was rejected",
        },
      });
    }
  });

  server.post("/v1/mfa/approvals/:approvalId/complete", { bodyLimit: 128 * 1024 }, async (request, reply) => {
    secureHeaders(reply);
    let approvalId: string;
    let principal: { readonly tenantId: string; readonly userId: string };
    try {
      approvalId = requireOpaqueId((request.params as Record<string, unknown>).approvalId, "approval");
      principal = await options.authorizeMfaCompletion(request, approvalId);
      requireOpaqueId(principal.tenantId, "tenant");
      requireOpaqueId(principal.userId, "user");
    } catch {
      return reply.status(401).send({ error: { code: "MFA_SESSION_REQUIRED", message: "A valid isolated MFA session is required" } });
    }
    try {
      const body = requireExactObject(request.body, ["assertion"], "MFA completion body");
      if (!body.assertion || typeof body.assertion !== "object" || Array.isArray(body.assertion)) {
        throw new Error("MFA assertion is invalid");
      }
      const result = await options.broker.complete({ ...principal, approvalId, assertion: body.assertion });
      return reply.status(200).send(result);
    } catch {
      return reply.status(400).send({
        error: { code: "MFA_COMPLETION_REJECTED", message: "MFA completion was rejected" },
      });
    }
  });
}

function requirePrincipal(value: unknown): ReleaseAuthorizationPrincipal {
  const body = requireExactObject(value, ["tenantId", "userId", "sessionBinding"], "Release authorization principal");
  const tenantId = requireOpaqueId(body.tenantId, "tenant");
  const userId = requireOpaqueId(body.userId, "user");
  const sessionBinding = body.sessionBinding;
  if (typeof sessionBinding !== "string" || sessionBinding.length < 32 || sessionBinding.length > 512
    || /[\u0000-\u001f\u007f]/.test(sessionBinding)) throw new Error("Release authorization session binding is invalid");
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
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`Release ${label} ID is invalid`);
  return value;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error("Release authorization idempotency key is invalid");
  }
  return value;
}

function secureHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
  reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
}
