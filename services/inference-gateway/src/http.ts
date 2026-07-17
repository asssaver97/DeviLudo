import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { GatewayAuthorizationError, InferenceGatewayAuthorizer } from "./authorization";
import type { GatewayConnector, GatewayProtocol, InferenceGatewayAuthorizerOptions } from "./contracts";

const SAFE_RESPONSE_HEADERS = new Set(["content-type", "x-request-id", "request-id"]);

export function buildInferenceGateway(options: InferenceGatewayAuthorizerOptions & { readonly connector?: GatewayConnector }): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const authorizer = new InferenceGatewayAuthorizer(options);

  server.get("/health", async () => Object.freeze({
    status: options.connector ? "ok" : "degraded",
    service: "deviludo-inference-gateway",
    connector: options.connector ? "CONFIGURED" : "NOT_CONFIGURED",
  }));

  server.post("/v1/responses", async (request, reply) => {
    return forward(request, reply, "openai-responses", authorizer, options.connector);
  });
  server.post("/v1/messages", async (request, reply) => {
    return forward(request, reply, "anthropic-messages", authorizer, options.connector);
  });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayAuthorizationError) {
      void reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    void reply.code(500).send({ error: { code: "GATEWAY_REQUEST_FAILED", message: "Inference Gateway request failed" } });
  });
  return server;
}

async function forward(
  request: FastifyRequest,
  reply: FastifyReply,
  protocol: GatewayProtocol,
  authorizer: InferenceGatewayAuthorizer,
  connector: GatewayConnector | undefined,
) {
  const body = objectBody(request.body);
  const model = body.model;
  if (typeof model !== "string") throw new GatewayAuthorizationError("MODEL_REQUIRED", "Request must include an exact model", 400);
  const token = extractRunToken(request, protocol);
  const authorization = await authorizer.authorize({ token, protocol, model });
  if (!connector) throw new GatewayAuthorizationError("CONNECTOR_NOT_CONFIGURED", "Provider connector is not configured", 503);
  const boundedBody = constrainOutputBudget(body, protocol, authorization.remainingBudget.maxOutputTokens);

  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  try {
    const upstream = await connector.forward({ authorization, body: boundedBody, signal: controller.signal });
    for (const [name, value] of Object.entries(upstream.headers ?? {})) {
      if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) reply.header(name, value);
    }
    return reply.code(safeStatus(upstream.statusCode)).send(upstream.body);
  } finally {
    request.raw.off("aborted", abort);
  }
}

function constrainOutputBudget(
  body: Readonly<Record<string, unknown>>,
  protocol: GatewayProtocol,
  remainingOutputTokens: number | undefined,
): Readonly<Record<string, unknown>> {
  if (remainingOutputTokens === undefined) return body;
  const field = protocol === "openai-responses" ? "max_output_tokens" : "max_tokens";
  const requested = body[field];
  if (requested !== undefined && (!Number.isInteger(requested) || (requested as number) <= 0)) {
    throw new GatewayAuthorizationError("INVALID_OUTPUT_LIMIT", "Output token limit must be a positive integer", 400);
  }
  if (typeof requested === "number" && requested > remainingOutputTokens) {
    throw new GatewayAuthorizationError("RUN_BUDGET_EXCEEDED", "Requested output exceeds the remaining run budget", 429);
  }
  return requested === undefined ? Object.freeze({ ...body, [field]: remainingOutputTokens }) : body;
}

function extractRunToken(request: FastifyRequest, protocol: GatewayProtocol): string {
  const authorization = singleHeader(request.headers.authorization);
  const apiKey = singleHeader(request.headers["x-api-key"]);
  if (authorization && apiKey) throw new GatewayAuthorizationError("AMBIGUOUS_AUTHENTICATION", "Send exactly one run token", 401);
  const value = protocol === "openai-responses"
    ? authorization?.match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1]
    : apiKey;
  if (!value || value.length > 16_384) throw new GatewayAuthorizationError("RUN_TOKEN_REQUIRED", "A run token is required", 401);
  return value;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectBody(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayAuthorizationError("INVALID_REQUEST", "Inference request body must be a JSON object", 400);
  }
  return value as Readonly<Record<string, unknown>>;
}

function safeStatus(value: number): number {
  return Number.isInteger(value) && value >= 200 && value <= 599 && (value < 300 || value >= 400) ? value : 502;
}
