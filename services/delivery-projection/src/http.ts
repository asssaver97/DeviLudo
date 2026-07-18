import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import { evidenceArchiveIdentityFromTlsSocket } from "../../evidence-archive/src/ingress-http";
import { parseDeliveryProjectionRequest } from "../../../lib/orchestration/delivery-projection";
import {
  DeliveryProjectionConflictError,
  DeliveryProjectionValidationError,
  type DeliveryProjectionStore,
} from "./store";

const MAX_BODY_BYTES = 4_500_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface DeliveryProjectionHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: unknown;
  readonly rawBody: string;
}
export interface DeliveryProjectionHttpResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function createDeliveryProjectionHandler(options: {
  readonly store: DeliveryProjectionStore;
  readonly writerSpiffeIds: ReadonlySet<string>;
  readonly readerSpiffeIds: ReadonlySet<string>;
  readonly extractIdentity?: (socket: unknown) => EvidenceArchiveWorkloadIdentity;
}) {
  if (!options.writerSpiffeIds.size || !options.readerSpiffeIds.size) throw new Error("Delivery projection workload allow-lists are required");
  for (const identity of options.writerSpiffeIds) {
    if (options.readerSpiffeIds.has(identity)) throw new Error("Delivery projection read and write identities must be separated");
  }
  const extract = options.extractIdentity ?? evidenceArchiveIdentityFromTlsSocket;
  return async (request: DeliveryProjectionHttpRequest): Promise<DeliveryProjectionHttpResponse> => {
    let identity: EvidenceArchiveWorkloadIdentity;
    try { identity = extract(request.socket); }
    catch { return failure(401, "DELIVERY_PROJECTION_MTLS_IDENTITY_REQUIRED"); }
    if (request.method === "GET" && request.path === "/healthz") {
      if (!options.writerSpiffeIds.has(identity.spiffeId) && !options.readerSpiffeIds.has(identity.spiffeId)) {
        return failure(403, "DELIVERY_PROJECTION_WORKLOAD_FORBIDDEN");
      }
      try { await options.store.probe(); }
      catch { return failure(503, "DELIVERY_PROJECTION_NOT_READY"); }
      return { status: 200, body: { status: "ok", service: "deviludo-delivery-projection" } };
    }
    if (request.method === "POST" && request.path === "/v1/delivery-projections") {
      if (!options.writerSpiffeIds.has(identity.spiffeId)) return failure(403, "DELIVERY_PROJECTION_WRITER_FORBIDDEN");
      if (contentType(request.headers["content-type"]) !== "application/json") return failure(415, "DELIVERY_PROJECTION_JSON_REQUIRED");
      try {
        const projection = parseDeliveryProjectionRequest(JSON.parse(request.rawBody) as unknown);
        if (single(request.headers["idempotency-key"]) !== projection.projectionKey
          || single(request.headers["x-deviludo-workflow-id"]) !== projection.snapshot.workflowId) {
          throw new DeliveryProjectionValidationError("Delivery projection transport binding is invalid");
        }
        const receipt = await options.store.persist(projection);
        return { status: receipt.replayed ? 200 : 201, body: { data: receipt } };
      } catch (error) { return mappedFailure(error); }
    }
    const match = request.method === "GET" ? /^\/v1\/delivery-projections\/([^/]+)$/.exec(request.path) : null;
    if (match) {
      if (!options.readerSpiffeIds.has(identity.spiffeId)) return failure(403, "DELIVERY_PROJECTION_READER_FORBIDDEN");
      const tenantId = single(request.headers["x-deviludo-tenant-id"]);
      let projectId: string;
      try { projectId = decodeURIComponent(match[1]!); }
      catch { return failure(400, "INVALID_DELIVERY_PROJECTION_READ"); }
      if (!tenantId || !UUID.test(tenantId) || !UUID.test(projectId) || request.rawBody.length) {
        return failure(400, "INVALID_DELIVERY_PROJECTION_READ");
      }
      try {
        const projection = await options.store.read(tenantId, projectId);
        return projection
          ? { status: 200, body: { data: projection } }
          : failure(404, "DELIVERY_PROJECTION_NOT_FOUND");
      } catch (error) { return mappedFailure(error); }
    }
    return failure(404, "DELIVERY_PROJECTION_ROUTE_NOT_FOUND");
  };
}

export function createDeliveryProjectionHttpsServer(options: {
  readonly tls: Pick<ServerOptions, "key" | "cert" | "ca">;
  readonly handler: (request: DeliveryProjectionHttpRequest) => Promise<DeliveryProjectionHttpResponse>;
}): HttpsServer {
  if (!options.tls.key || !options.tls.cert || !options.tls.ca) throw new Error("Delivery projection TLS material is incomplete");
  const server = createServer({
    ...options.tls,
    minVersion: "TLSv1.3",
    requestCert: true,
    rejectUnauthorized: true,
  }, (request, response) => { void dispatch(request, response, options.handler); });
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: DeliveryProjectionHttpRequest) => Promise<DeliveryProjectionHttpResponse>,
) {
  try {
    const rawBody = await readBody(request);
    send(response, await handler({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      socket: request.socket,
      rawBody,
    }));
  } catch (error) {
    send(response, failure(error instanceof BodyLimitError ? 413 : 500,
      error instanceof BodyLimitError ? "DELIVERY_PROJECTION_REQUEST_TOO_LARGE" : "DELIVERY_PROJECTION_UNAVAILABLE"));
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes <= MAX_BODY_BYTES) chunks.push(value);
    });
    request.once("end", () => bytes > MAX_BODY_BYTES ? reject(new BodyLimitError()) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("aborted")));
  });
}

function send(response: ServerResponse, result: DeliveryProjectionHttpResponse): void {
  const body = JSON.stringify(result.body);
  response.statusCode = result.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}
function mappedFailure(error: unknown): DeliveryProjectionHttpResponse {
  if (error instanceof DeliveryProjectionConflictError) return failure(409, "DELIVERY_PROJECTION_CONFLICT");
  if (error instanceof DeliveryProjectionValidationError || error instanceof SyntaxError
    || (error instanceof Error && error.message.startsWith("Delivery "))) return failure(400, "INVALID_DELIVERY_PROJECTION");
  return failure(503, "DELIVERY_PROJECTION_UNAVAILABLE");
}
function single(value: string | readonly string[] | undefined): string | null { return typeof value === "string" ? value : null; }
function contentType(value: string | readonly string[] | undefined): string | null { return single(value)?.toLowerCase().split(";", 1)[0]?.trim() ?? null; }
function failure(status: number, code: string): DeliveryProjectionHttpResponse { return { status, body: { error: { code } } }; }
class BodyLimitError extends Error {}
