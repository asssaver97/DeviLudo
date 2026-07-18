import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, request as httpsRequest, type RequestOptions, type Server } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import type { SecretResolutionContext, SecretResolver } from "../../agent-worker/src/contracts";
import type { NativeMicrovmAgentRequest } from "./native-microvm-contracts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const SAFE_FORWARD_HEADERS = new Set([
  "accept", "anthropic-beta", "anthropic-version", "content-type", "openai-beta",
  "user-agent", "x-request-id",
]);
const SAFE_RESPONSE_HEADERS = new Set(["cache-control", "content-type", "request-id", "x-request-id"]);

export interface NativeGuestInferenceRelayHandle {
  readonly gatewayUrl: string;
  readonly runTokenSecretRef: string;
  readonly secretResolver: SecretResolver;
  close(): Promise<void>;
}

export interface NativeGuestInferenceRelay {
  start(request: NativeMicrovmAgentRequest): Promise<NativeGuestInferenceRelayHandle>;
}

export interface NativeGuestRelayTls {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca?: Buffer;
}

/**
 * Loopback-only HTTPS relay. The CLI receives a random attempt-local password;
 * every inference request resolves the current DLRT behind one stable
 * SecretRef and replaces local authentication before forwarding to Gateway.
 */
export class HttpsNativeGuestInferenceRelay implements NativeGuestInferenceRelay {
  readonly #origin: URL & { readonly portNumber: number };
  readonly #serverTls: NativeGuestRelayTls;
  readonly #gatewayTls: Required<NativeGuestRelayTls>;
  readonly #tokens: SecretResolver;

  constructor(options: Readonly<{
    origin: string | URL;
    serverTls: NativeGuestRelayTls;
    gatewayTls: Required<NativeGuestRelayTls>;
    tokenResolver: SecretResolver;
  }>) {
    this.#origin = relayOrigin(options.origin);
    validateTls(options.serverTls, false);
    validateTls(options.gatewayTls, true);
    this.#serverTls = Object.freeze({ ...options.serverTls });
    this.#gatewayTls = Object.freeze({ ...options.gatewayTls });
    this.#tokens = options.tokenResolver;
  }

  async start(request: NativeMicrovmAgentRequest): Promise<NativeGuestInferenceRelayHandle> {
    const localSecret = randomBytes(32);
    const localToken = localSecret.toString("base64url");
    const localCredential = Buffer.from(localToken, "utf8");
    const localRef = `secret://guest-inference-relay/${request.runId}/${request.attemptId}`;
    const context = Object.freeze({ runId: request.runId, attemptId: request.attemptId,
      environmentVariable: request.agent === "claude-code" ? "ANTHROPIC_API_KEY" : "DEVILUDO_RUN_TOKEN" });
    const localResolver = new AttemptLocalSecretResolver(localRef, localToken, context);
    const server = createServer({ key: this.#serverTls.key, cert: this.#serverTls.certificate,
      minVersion: "TLSv1.3" }, (incoming, outgoing) => {
      void this.#forward(incoming, outgoing, request, localCredential, context);
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    try { await listen(server, this.#origin.portNumber, "127.0.0.1"); }
    catch (error) { localResolver.revoke(); localSecret.fill(0); localCredential.fill(0); throw error; }
    let closed = false;
    return Object.freeze({
      gatewayUrl: this.#origin.toString(),
      runTokenSecretRef: localRef,
      secretResolver: localResolver,
      close: async () => {
        if (closed) return;
        closed = true;
        localResolver.revoke();
        localSecret.fill(0); localCredential.fill(0);
        await close(server);
      },
    });
  }

  async #forward(incoming: IncomingMessage, outgoing: ServerResponse, request: NativeMicrovmAgentRequest,
    localSecret: Buffer, context: SecretResolutionContext): Promise<void> {
    try {
      const path = request.providerProtocol === "anthropic-messages" ? "/v1/messages" : "/v1/responses";
      if (incoming.method !== "POST" || incoming.url !== path
        || !authorizedLocalRequest(incoming.headers, request.providerProtocol, localSecret)) {
        reject(outgoing, 404);
        incoming.resume();
        return;
      }
      const length = contentLength(incoming.headers);
      if (length !== null && length > MAX_REQUEST_BYTES) {
        reject(outgoing, 413); incoming.resume(); return;
      }
      const runToken = await this.#tokens.resolve(request.inferenceTokenSecretRef, context);
      const endpoint = new URL(path, request.inferenceGatewayUrl);
      const headers = forwardHeaders(incoming.headers);
      if (request.providerProtocol === "anthropic-messages") headers["x-api-key"] = runToken;
      else headers.authorization = `Bearer ${runToken}`;
      const options: RequestOptions = {
        method: "POST", headers, key: this.#gatewayTls.key, cert: this.#gatewayTls.certificate,
        ca: this.#gatewayTls.ca, rejectUnauthorized: true, minVersion: "TLSv1.3", servername: endpoint.hostname,
      };
      await proxy(incoming, outgoing, endpoint, options);
    } catch {
      if (!outgoing.headersSent) reject(outgoing, 502);
      else outgoing.destroy();
      incoming.destroy();
    }
  }
}

class AttemptLocalSecretResolver implements SecretResolver {
  #revoked = false;
  constructor(private readonly ref: string, private readonly token: string,
    private readonly expected: SecretResolutionContext) {}
  async resolve(secretRef: string, context: SecretResolutionContext): Promise<string> {
    if (this.#revoked || secretRef !== this.ref || context.runId !== this.expected.runId
      || context.attemptId !== this.expected.attemptId
      || context.environmentVariable !== this.expected.environmentVariable) invalid();
    return this.token;
  }
  revoke(): void { this.#revoked = true; }
}

export function authorizedLocalRequest(headers: IncomingHttpHeaders,
  protocol: NativeMicrovmAgentRequest["providerProtocol"], expected: Buffer): boolean {
  const authorization = single(headers.authorization);
  const apiKey = single(headers["x-api-key"]);
  if (authorization && apiKey) return false;
  const actual = protocol === "anthropic-messages" ? apiKey : authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (!actual) return false;
  const bytes = Buffer.from(actual, "utf8");
  return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
}

function proxy(incoming: IncomingMessage, outgoing: ServerResponse, endpoint: URL,
  options: RequestOptions): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let bytes = 0;
    const upstream = httpsRequest(endpoint, options, (response) => {
      const status = response.statusCode ?? 502;
      if (status < 200 || status > 599 || status >= 300 && status < 400) {
        response.resume(); rejectPromise(new Error("Gateway response status is invalid")); return;
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
    const abort = () => upstream.destroy(new Error("CLI request aborted"));
    incoming.once("aborted", abort);
    incoming.on("data", (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) upstream.destroy(new Error("Relay request exceeded the limit"));
    });
    incoming.once("error", rejectPromise);
    upstream.once("error", rejectPromise);
    upstream.once("close", () => incoming.off("aborted", abort));
    incoming.pipe(upstream);
  });
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SAFE_FORWARD_HEADERS.has(name) && typeof value === "string") result[name] = value;
  }
  result["cache-control"] = "no-store";
  return result;
}
function contentLength(headers: IncomingHttpHeaders): number | null {
  const value = single(headers["content-length"]);
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]{0,7})$/.test(value)) invalid();
  return Number(value);
}
function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store", "content-length": "0" }); response.end();
}
function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function relayOrigin(value: string | URL): URL & { readonly portNumber: number } {
  const url = new URL(value.toString());
  if (url.protocol !== "https:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
    || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) invalid();
  const port = Number.parseInt(url.port, 10);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) invalid();
  url.pathname = "/";
  return Object.assign(url, { portNumber: port });
}
function validateTls(value: NativeGuestRelayTls, requireCa: boolean): void {
  const items = [value.key, value.certificate, ...(requireCa ? [value.ca] : [])];
  if (items.some((item) => !Buffer.isBuffer(item) || item.byteLength < 32 || item.byteLength > 1024 * 1024)) invalid();
}
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const error = (reason: Error) => rejectPromise(reason);
    server.once("error", error);
    server.listen(port, host, () => { server.off("error", error); resolvePromise(); });
  });
}
function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
}

export async function nativeGuestInferenceRelayFromEnv(tokenResolver: SecretResolver,
  env: Readonly<Record<string, string | undefined>> = process.env): Promise<NativeGuestInferenceRelay> {
  const [serverKey, serverCertificate, gatewayKey, gatewayCertificate, gatewayCa] = await Promise.all([
    read(env, "DEVILUDO_MICROVM_GUEST_RELAY_TLS_KEY_FILE"),
    read(env, "DEVILUDO_MICROVM_GUEST_RELAY_TLS_CERT_FILE"),
    read(env, "DEVILUDO_MICROVM_GUEST_GATEWAY_TLS_KEY_FILE"),
    read(env, "DEVILUDO_MICROVM_GUEST_GATEWAY_TLS_CERT_FILE"),
    read(env, "DEVILUDO_MICROVM_GUEST_GATEWAY_CA_FILE"),
  ]);
  return new HttpsNativeGuestInferenceRelay({ origin: required(env, "DEVILUDO_MICROVM_GUEST_RELAY_ORIGIN"),
    serverTls: { key: serverKey, certificate: serverCertificate },
    gatewayTls: { key: gatewayKey, certificate: gatewayCertificate, ca: gatewayCa }, tokenResolver });
}
async function read(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || path.includes("\0")) invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) invalid();
    return await file.readFile(); } finally { await file.close(); }
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim(); if (!value) invalid(); return value;
}
function invalid(): never { throw new Error("Native guest inference relay is invalid"); }
