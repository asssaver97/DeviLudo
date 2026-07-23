import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import type { SecretResolutionContext, SecretResolver } from "../../agent-worker/src/contracts";
import type { LocalAgentExecutionRequest } from "./contracts";
import type {
  LocalInferenceRelay,
  LocalInferenceRelayHandle,
  PreparedLocalRunToken,
} from "./isolated-executor";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const SAFE_FORWARD_HEADERS = new Set([
  "accept", "anthropic-beta", "anthropic-version", "content-type", "openai-beta",
  "user-agent", "x-request-id",
]);
const SAFE_RESPONSE_HEADERS = new Set(["cache-control", "content-type", "request-id", "x-request-id"]);

type AttemptSecret = Readonly<{
  value: Buffer;
  runId: string;
  attemptId: string;
  environmentVariable: "ANTHROPIC_API_KEY" | "DEVILUDO_RUN_TOKEN";
}>;

/**
 * Local-test counterpart of the production microVM relay. The CLI receives a
 * random attempt-local password and never sees a DLRT. Each request renews the
 * stable DLRT SecretRef when needed, resolves its current value, and forwards
 * only to the fixed loopback Gateway.
 */
export class LoopbackLocalInferenceRelay implements LocalInferenceRelay {
  readonly #gateway: URL;
  readonly #tokens: SecretResolver;
  readonly #attemptSecrets = new Map<string, AttemptSecret>();
  readonly #servers = new Set<Server>();

  readonly secrets: SecretResolver = Object.freeze({
    resolve: async (secretRef: string, context: SecretResolutionContext) => {
      const stored = this.#attemptSecrets.get(secretRef);
      if (!stored || stored.runId !== context.runId || stored.attemptId !== context.attemptId
        || stored.environmentVariable !== context.environmentVariable) {
        throw new Error("Local inference relay SecretRef is unavailable");
      }
      return stored.value.toString("utf8");
    },
  });

  constructor(options: Readonly<{ gatewayUrl: string | URL; tokenResolver: SecretResolver }>) {
    this.#gateway = gatewayUrl(options.gatewayUrl);
    this.#tokens = options.tokenResolver;
  }

  async start(input: Readonly<{
    request: LocalAgentExecutionRequest;
    token: PreparedLocalRunToken;
  }>): Promise<LocalInferenceRelayHandle> {
    const { request, token } = input;
    const environmentVariable = request.agent === "claude-code" ? "ANTHROPIC_API_KEY" : "DEVILUDO_RUN_TOKEN";
    const localSecret = randomBytes(32);
    const localCredential = Buffer.from(localSecret.toString("base64url"), "utf8");
    localSecret.fill(0);
    const secretRef = `secret://local-inference-relay/${createHash("sha256").update([
      request.tenantId, request.projectId, request.runId, request.attemptId,
    ].join("\0")).digest("hex")}`;
    if (this.#attemptSecrets.has(secretRef)) {
      localCredential.fill(0);
      throw new Error("Local inference relay attempt is already active");
    }
    const context = Object.freeze({ runId: request.runId, attemptId: request.attemptId, environmentVariable });
    const server = createServer((incoming, outgoing) => {
      void this.#route(incoming, outgoing, request, token, localCredential, context);
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    try {
      const port = await listen(server);
      this.#attemptSecrets.set(secretRef, Object.freeze({ value: localCredential, ...context }));
      this.#servers.add(server);
      let closed = false;
      return Object.freeze({
        gatewayUrl: `http://127.0.0.1:${port}`,
        runTokenSecretRef: secretRef,
        close: async () => {
          if (closed) return;
          closed = true;
          this.#attemptSecrets.delete(secretRef);
          localCredential.fill(0);
          this.#servers.delete(server);
          await close(server);
        },
      });
    } catch (error) {
      localCredential.fill(0);
      throw error;
    }
  }

  async close(): Promise<void> {
    const servers = [...this.#servers];
    this.#servers.clear();
    for (const secret of this.#attemptSecrets.values()) secret.value.fill(0);
    this.#attemptSecrets.clear();
    await Promise.allSettled(servers.map(close));
  }

  async #route(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    request: LocalAgentExecutionRequest,
    token: PreparedLocalRunToken,
    localCredential: Buffer,
    context: SecretResolutionContext,
  ): Promise<void> {
    const path = request.providerProtocol === "anthropic-messages" ? "/v1/messages" : "/v1/responses";
    try {
      if (incoming.method !== "POST" || incoming.url !== path
        || !authorizedLocalRelayRequest(incoming.headers, request.providerProtocol, localCredential)) {
        reject(outgoing, 404);
        incoming.resume();
        return;
      }
      const declaredLength = contentLength(incoming.headers);
      if (declaredLength !== null && declaredLength > MAX_REQUEST_BYTES) {
        reject(outgoing, 413);
        incoming.resume();
        return;
      }
      const body = await readBody(incoming);
      await token.renew();
      const runToken = await this.#tokens.resolve(token.secretRef, context);
      const endpoint = new URL(path, this.#gateway.origin);
      const headers = forwardHeaders(incoming.headers);
      headers["content-length"] = String(body.byteLength);
      if (request.providerProtocol === "anthropic-messages") headers["x-api-key"] = runToken;
      else headers.authorization = `Bearer ${runToken}`;
      await proxy(body, outgoing, endpoint, { method: "POST", headers });
    } catch (error) {
      if (!outgoing.headersSent) reject(outgoing, error instanceof RequestTooLargeError ? 413 : 502);
      else outgoing.destroy();
      incoming.destroy();
    }
  }
}

export function authorizedLocalRelayRequest(
  headers: IncomingHttpHeaders,
  protocol: LocalAgentExecutionRequest["providerProtocol"],
  expected: Buffer,
): boolean {
  const authorization = single(headers.authorization);
  const apiKey = single(headers["x-api-key"]);
  if (authorization && apiKey) return false;
  const actual = protocol === "anthropic-messages"
    ? apiKey
    : authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (!actual) return false;
  const bytes = Buffer.from(actual, "utf8");
  return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
}

function readBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    incoming.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        rejectPromise(new RequestTooLargeError());
        incoming.destroy();
        return;
      }
      chunks.push(value);
    });
    incoming.once("end", () => resolvePromise(Buffer.concat(chunks)));
    incoming.once("aborted", () => rejectPromise(new Error("Local relay request was aborted")));
    incoming.once("error", rejectPromise);
  });
}

function proxy(body: Buffer, outgoing: ServerResponse, endpoint: URL, options: RequestOptions): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const upstream = httpRequest(endpoint, options, (response) => {
      const status = response.statusCode ?? 502;
      if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
        response.resume();
        rejectPromise(new Error("Local Gateway response status is invalid"));
        return;
      }
      const headers: Record<string, string> = { "cache-control": "no-store" };
      for (const [name, value] of Object.entries(response.headers)) {
        if (SAFE_RESPONSE_HEADERS.has(name) && typeof value === "string") headers[name] = value;
      }
      outgoing.writeHead(status, headers);
      response.pipe(outgoing);
      response.once("end", resolvePromise);
      response.once("error", rejectPromise);
    });
    const abort = () => upstream.destroy(new Error("Local CLI inference request was aborted"));
    outgoing.once("close", abort);
    upstream.once("error", rejectPromise);
    upstream.once("close", () => outgoing.off("close", abort));
    upstream.end(body);
  });
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = { "cache-control": "no-store" };
  for (const [name, value] of Object.entries(headers)) {
    if (SAFE_FORWARD_HEADERS.has(name) && typeof value === "string") result[name] = value;
  }
  return result;
}

function contentLength(headers: IncomingHttpHeaders): number | null {
  const value = single(headers["content-length"]);
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]{0,7})$/.test(value)) throw new Error("Local relay content length is invalid");
  return Number(value);
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store", "content-length": "0" });
  response.end();
}

function gatewayUrl(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/+$/, "") !== "/v1") {
    throw new Error("Local inference relay requires the fixed loopback Gateway /v1 URL");
  }
  return url;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const error = (reason: Error) => rejectPromise(reason);
    server.once("error", error);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", error);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Local inference relay address is unavailable"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
}

class RequestTooLargeError extends Error {}
