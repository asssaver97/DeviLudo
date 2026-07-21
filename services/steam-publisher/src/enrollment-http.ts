import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  SteamEnrollmentPrincipal,
  SteamConnectionStatus,
  SteamEnrollmentView,
} from "./enrollment-contracts";

export interface SteamEnrollmentBrokerPort {
  connectionStatus(principal: SteamEnrollmentPrincipal): Promise<SteamConnectionStatus>;
  begin(principal: SteamEnrollmentPrincipal, idempotencyKey: string): Promise<SteamEnrollmentView>;
}

export interface SteamEnrollmentInteractiveBrokerPort {
  submitCredentials(input: {
    readonly principal: SteamEnrollmentPrincipal;
    readonly enrollmentId: string;
    readonly accountName: string;
    readonly password: Uint8Array;
  }): Promise<SteamEnrollmentView>;
  submitGuardCode(input: {
    readonly principal: SteamEnrollmentPrincipal;
    readonly enrollmentId: string;
    readonly guardCode: Uint8Array;
  }): Promise<SteamEnrollmentView>;
}

export function registerSteamEnrollmentBrokerRoutes(
  server: FastifyInstance,
  options: {
    readonly broker: SteamEnrollmentBrokerPort;
    /** Authenticates the Web/control-plane workload over mTLS. */
    readonly authorize: (request: FastifyRequest) => void | Promise<void>;
    readonly interactiveBroker?: SteamEnrollmentInteractiveBrokerPort;
    /** Authenticates the separately hosted secure UI and derives its user. */
    readonly authorizeInteractive?: (
      request: FastifyRequest,
      enrollmentId: string,
      action: "SUBMIT_CREDENTIALS" | "SUBMIT_GUARD_CODE",
    ) => SteamEnrollmentPrincipal | Promise<SteamEnrollmentPrincipal>;
  },
): void {
  server.post("/v1/steam/enrollments/status", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    secureHeaders(reply);
    try {
      await options.authorize(request);
    } catch {
      return reply.status(401).send({
        error: { code: "WORKLOAD_IDENTITY_REQUIRED", message: "Authorized Web workload identity is required" },
      });
    }
    try {
      const body = requireExactObject(request.body, ["principal"], "Steam connection status body");
      return reply.status(200).send(await options.broker.connectionStatus(requirePrincipal(body.principal)));
    } catch {
      return reply.status(400).send({
        error: { code: "STEAM_CONNECTION_STATUS_REJECTED", message: "Steam connection status request was rejected" },
      });
    }
  });

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

  if (!options.interactiveBroker || !options.authorizeInteractive) return;
  if (!server.hasContentTypeParser("application/octet-stream")) {
    server.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 2 * 1024 }, (_request, body, done) => {
      done(null, body);
    });
  }

  server.post("/v1/steam/enrollments/:enrollmentId/credentials", {
    bodyLimit: 1024,
    onRequest: binarySecretsOnly,
  }, async (request, reply) => {
    secureHeaders(reply);
    const password = rawSensitiveBody(request.body);
    try {
      let enrollmentId: string;
      let principal: SteamEnrollmentPrincipal;
      try {
        enrollmentId = requireEnrollmentId((request.params as Record<string, unknown>).enrollmentId);
        principal = await options.authorizeInteractive!(request, enrollmentId, "SUBMIT_CREDENTIALS");
      } catch {
        return reply.status(401).send({ error: { code: "STEAM_ENROLLMENT_UI_SESSION_REQUIRED", message: "Authorized secure enrollment UI session is required" } });
      }
      if (!password || password.byteLength < 8 || password.byteLength > 1024) {
        return reply.status(400).send({ error: { code: "STEAM_CREDENTIALS_REJECTED", message: "Steam credentials were rejected" } });
      }
      try {
        const accountName = requireAccountName(request.headers["x-steam-account-name"]);
        const result = await options.interactiveBroker!.submitCredentials({ principal, enrollmentId, accountName, password });
        return reply.status(result.state === "READY" ? 200 : 202).send(result);
      } catch {
        return reply.status(400).send({ error: { code: "STEAM_CREDENTIALS_REJECTED", message: "Steam credentials were rejected" } });
      }
    } finally {
      password?.fill(0);
    }
  });

  server.post("/v1/steam/enrollments/:enrollmentId/guard", {
    bodyLimit: 64,
    onRequest: binarySecretsOnly,
  }, async (request, reply) => {
    secureHeaders(reply);
    const guardCode = rawSensitiveBody(request.body);
    try {
      let enrollmentId: string;
      let principal: SteamEnrollmentPrincipal;
      try {
        enrollmentId = requireEnrollmentId((request.params as Record<string, unknown>).enrollmentId);
        principal = await options.authorizeInteractive!(request, enrollmentId, "SUBMIT_GUARD_CODE");
      } catch {
        return reply.status(401).send({ error: { code: "STEAM_ENROLLMENT_UI_SESSION_REQUIRED", message: "Authorized secure enrollment UI session is required" } });
      }
      if (!guardCode || guardCode.byteLength < 4 || guardCode.byteLength > 32) {
        return reply.status(400).send({ error: { code: "STEAM_GUARD_REJECTED", message: "Steam Guard code was rejected" } });
      }
      try {
        const result = await options.interactiveBroker!.submitGuardCode({ principal, enrollmentId, guardCode });
        return reply.status(result.state === "READY" ? 200 : 202).send(result);
      } catch {
        return reply.status(400).send({ error: { code: "STEAM_GUARD_REJECTED", message: "Steam Guard code was rejected" } });
      }
    } finally {
      guardCode?.fill(0);
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

function requireEnrollmentId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new Error("Steam enrollment ID is invalid");
  return value;
}

function requireAccountName(value: string | readonly string[] | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(value)) throw new Error("Steam account name is invalid");
  return value;
}

function rawSensitiveBody(value: unknown): Uint8Array | null {
  if (!Buffer.isBuffer(value)) return null;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

async function binarySecretsOnly(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.headers["content-type"] !== "application/octet-stream") {
    secureHeaders(reply);
    await reply.status(415).send({
      error: { code: "BINARY_SECRET_BODY_REQUIRED", message: "A binary secret body is required" },
    });
  }
}

function secureHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
  reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
}
