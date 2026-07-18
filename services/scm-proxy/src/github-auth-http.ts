import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  GitHubAuthorizationPrincipal,
  GitHubVerifiedInstallation,
} from "./github-auth-contracts";

export interface GitHubAuthorizationBrokerPort {
  begin(principal: GitHubAuthorizationPrincipal, returnPath?: string): Promise<{
    readonly authorizeUrl: string;
    readonly expiresAt: string;
  }>;
  beginUserAuthorization(input: {
    readonly principal: GitHubAuthorizationPrincipal;
    readonly state: string;
    readonly installationId: string;
    readonly setupAction: "install" | "update";
  }): Promise<{ readonly authorizeUrl: string; readonly expiresAt: string }>;
  completeUserAuthorization(input: {
    readonly principal: GitHubAuthorizationPrincipal;
    readonly state: string;
    readonly code: string;
  }): Promise<{ readonly installation: GitHubVerifiedInstallation; readonly returnPath: string }>;
}

export interface GitHubBrokerRequestLedger {
  execute<T extends Readonly<Record<string, unknown>>>(input: {
    readonly tenantId: string;
    readonly operationName: "BEGIN" | "SETUP" | "COMPLETE";
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly operation: () => Promise<T>;
  }): Promise<T>;
}

export interface GitHubBrokerRouteOptions {
  readonly broker: GitHubAuthorizationBrokerPort;
  readonly ledger: GitHubBrokerRequestLedger;
  /** Must authenticate the calling Web/control-plane workload via mTLS. */
  readonly authorize: (request: FastifyRequest) => void | Promise<void>;
}

export function registerGitHubAuthorizationBrokerRoutes(
  server: FastifyInstance,
  options: GitHubBrokerRouteOptions,
): void {
  const route = (
    path: string,
    operation: "BEGIN" | "SETUP" | "COMPLETE",
    handler: (body: Record<string, unknown>) => Promise<Readonly<Record<string, unknown>>>,
    successStatus: number,
  ) => {
    server.post(path, { bodyLimit: 64 * 1024 }, async (request, reply) => {
      secureHeaders(reply);
      try {
        await options.authorize(request);
      } catch {
        return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED", message: "Authorized Web workload identity is required" } });
      }
      try {
        const body = requireObject(request.body);
        const principal = requirePrincipal(body.principal);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestDigest = canonicalDigest({ path, body });
        const result = await options.ledger.execute({
          tenantId: principal.tenantId,
          operationName: operation,
          idempotencyKey,
          requestDigest,
          operation: () => handler(body),
        });
        return reply.status(successStatus).send(result);
      } catch (error) {
        const conflict = error instanceof Error && error.message.includes("idempotency key");
        return reply.status(conflict ? 409 : 400).send({
          error: {
            code: conflict ? "IDEMPOTENCY_CONFLICT" : "GITHUB_AUTHORIZATION_REJECTED",
            message: conflict ? "Idempotency key conflicts with another request" : "GitHub authorization request was rejected",
          },
        });
      }
    });
  };

  route("/v1/github/authorizations/begin", "BEGIN", async (body) => {
    exactKeys(body, ["principal", "returnPath"]);
    const principal = requirePrincipal(body.principal);
    if (body.returnPath !== "/settings/connections") throw new Error("GitHub authorization return path is invalid");
    return options.broker.begin(principal, body.returnPath);
  }, 201);

  route("/v1/github/authorizations/setup", "SETUP", async (body) => {
    exactKeys(body, ["installationId", "principal", "setupAction", "state"]);
    const principal = requirePrincipal(body.principal);
    const state = requireState(body.state);
    const installationId = requireInstallationId(body.installationId);
    const setupAction = body.setupAction;
    if (setupAction !== "install" && setupAction !== "update") throw new Error("GitHub setup action is invalid");
    return options.broker.beginUserAuthorization({ principal, state, installationId, setupAction });
  }, 200);

  route("/v1/github/authorizations/complete", "COMPLETE", async (body) => {
    exactKeys(body, ["code", "principal", "state"]);
    const principal = requirePrincipal(body.principal);
    const state = requireState(body.state);
    const code = requireCode(body.code);
    const result = await options.broker.completeUserAuthorization({ principal, state, code });
    return Object.freeze({ returnPath: result.returnPath });
  }, 200);
}

type LedgerRecord = {
  readonly requestDigest: string;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly pending: Promise<Readonly<Record<string, unknown>>> | null;
};

/** Test/local ledger. Production must inject a PostgreSQL-backed implementation. */
export class InMemoryGitHubBrokerRequestLedger implements GitHubBrokerRequestLedger {
  readonly #records = new Map<string, LedgerRecord>();

  async execute<T extends Readonly<Record<string, unknown>>>(input: {
    readonly tenantId: string;
    readonly operationName: "BEGIN" | "SETUP" | "COMPLETE";
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly operation: () => Promise<T>;
  }): Promise<T> {
    const ledgerKey = `${input.tenantId}:${input.operationName}:${input.idempotencyKey}`;
    const existing = this.#records.get(ledgerKey);
    if (existing && existing.requestDigest !== input.requestDigest) {
      throw new Error("GitHub broker idempotency key was reused with another request");
    }
    if (existing?.result) return existing.result as T;
    if (existing?.pending) return existing.pending as Promise<T>;
    const pending = input.operation()
      .then((result) => {
        const frozen = Object.freeze({ ...result });
        this.#records.set(ledgerKey, { requestDigest: input.requestDigest, result: frozen, pending: null });
        return frozen;
      })
      .catch((error) => {
        this.#records.delete(ledgerKey);
        throw error;
      });
    this.#records.set(ledgerKey, { requestDigest: input.requestDigest, result: null, pending });
    return pending as Promise<T>;
  }
}

function requirePrincipal(value: unknown): GitHubAuthorizationPrincipal {
  const body = requireObject(value);
  exactKeys(body, ["expectedGithubUserId", "sessionBinding", "tenantId", "userId"]);
  const tenantId = requireOpaqueId(body.tenantId, "tenant");
  const userId = requireOpaqueId(body.userId, "user");
  const sessionBinding = body.sessionBinding;
  const expectedGithubUserId = body.expectedGithubUserId;
  if (typeof sessionBinding !== "string" || sessionBinding.length < 32 || sessionBinding.length > 512 || /[\u0000-\u001f\u007f]/.test(sessionBinding)) {
    throw new Error("GitHub authorization session binding is invalid");
  }
  if (!Number.isSafeInteger(expectedGithubUserId) || (expectedGithubUserId as number) < 1) {
    throw new Error("GitHub authorization user binding is invalid");
  }
  return Object.freeze({ tenantId, userId, sessionBinding, expectedGithubUserId: expectedGithubUserId as number });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error("GitHub broker body contains unexpected fields");
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub broker body is invalid");
  return value as Record<string, unknown>;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`GitHub ${label} ID is invalid`);
  return value;
}

function requireState(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("GitHub authorization state is invalid");
  return value;
}

function requireInstallationId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value) || value === "0") throw new Error("GitHub installation ID is invalid");
  return value;
}

function requireCode(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u0020]/.test(value)) throw new Error("GitHub OAuth code is invalid");
  return value;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error("GitHub broker idempotency key is invalid");
  }
  return value;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function secureHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
}
