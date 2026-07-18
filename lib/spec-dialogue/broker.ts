import { parseSpecModelResult, type SpecApprovalReceipt, type SpecDialogueMessage, type SpecDialogueSnapshot } from "@/services/spec-dialogue/src/contracts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface TrustedSpecSession { readonly tenantId: string; readonly userId: string; readonly sessionBinding: string }

export class SpecDialogueBrokerClient {
  readonly #origin: URL;
  readonly #fetch: typeof fetch;
  constructor(endpoint: string, fetcher: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("Specification dialogue Broker endpoint is invalid");
    }
    this.#origin = url;
    this.#fetch = fetcher;
  }

  async send(command: Readonly<Record<string, unknown>>): Promise<SpecDialogueSnapshot> {
    const result = await this.#call("/v1/spec-dialogue/messages", command, command.operationKey as string, 201);
    if (!result) invalid();
    return result;
  }

  snapshot(binding: Readonly<Record<string, unknown>>): Promise<SpecDialogueSnapshot | null> {
    return this.#call("/v1/spec-dialogue/snapshot", binding, null, 200);
  }

  async approve(command: Readonly<Record<string, unknown>>): Promise<SpecApprovalReceipt> {
    const response = await this.#fetch(new URL("/v1/spec-dialogue/approve", this.#origin), {
      method: "POST", redirect: "manual",
      headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": command.operationKey as string },
      body: JSON.stringify(command), signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 201) throw new Error(`Specification approval Broker rejected the request with status ${response.status}`);
    const envelope = object(await response.json());
    if (JSON.stringify(Object.keys(envelope)) !== JSON.stringify(["data"])) invalid();
    return parseApproval(envelope.data, command);
  }

  async #call(path: string, body: Readonly<Record<string, unknown>>, operationKey: string | null, expectedStatus: number) {
    const response = await this.#fetch(new URL(path, this.#origin), {
      method: "POST",
      redirect: "manual",
      headers: { accept: "application/json", "content-type": "application/json", ...(operationKey ? { "idempotency-key": operationKey } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (response.status !== expectedStatus) throw new Error(`Specification dialogue Broker rejected the request with status ${response.status}`);
    const envelope = object(await response.json());
    if (JSON.stringify(Object.keys(envelope)) !== JSON.stringify(["data"])) invalid();
    if (envelope.data === null && expectedStatus === 200) return null;
    return parseSnapshot(envelope.data, body);
  }
}

export function specDialogueBrokerRuntimeFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env) {
  const endpoint = env.DEVILUDO_SPEC_DIALOGUE_BROKER_URL?.trim();
  if (!endpoint) return null;
  return Object.freeze({ broker: new SpecDialogueBrokerClient(endpoint), sessionHmacKey: trustedSessionKeyFromEnvironment(env) });
}

export function trustedSessionKeyFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Uint8Array {
  const encodedKey = env.DEVILUDO_SESSION_HMAC_KEY?.trim();
  if (!encodedKey) throw new Error("DEVILUDO_SESSION_HMAC_KEY is required for trusted platform sessions");
  const key = decodeBase64Url(encodedKey);
  if (key.byteLength < 32 || key.byteLength > 64) throw new Error("Platform session HMAC key is invalid");
  return key;
}

export async function verifyTrustedSpecSession(request: Request, key: Uint8Array, now = new Date()): Promise<TrustedSpecSession> {
  const tenantId = header(request, "x-deviludo-session-tenant", 200);
  const userId = header(request, "x-deviludo-session-user", 200);
  const sessionBinding = header(request, "x-deviludo-session-binding", 512);
  const issuedAt = header(request, "x-deviludo-session-issued-at", 20);
  const signature = header(request, "x-deviludo-session-signature", 100);
  if (!SAFE_ID.test(tenantId) || !SAFE_ID.test(userId) || sessionBinding.length < 32
    || /[\u0000-\u001f\u007f]/.test(sessionBinding) || !/^\d{13}$/.test(issuedAt)
    || !SIGNATURE.test(signature) || Math.abs(now.getTime() - Number(issuedAt)) > 60_000) invalid();
  const canonical = [request.method, new URL(request.url).pathname, tenantId, userId, sessionBinding, issuedAt].join("\n");
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", cryptoKey, arrayBuffer(decodeBase64Url(signature)), new TextEncoder().encode(canonical))) invalid();
  return Object.freeze({ tenantId, userId, sessionBinding });
}

/** Trusted session proxy helper used by integration tests and the ingress proxy. */
export async function signTrustedSpecSession(input: {
  readonly method: string;
  readonly pathname: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBinding: string;
  readonly issuedAt: string;
  readonly key: Uint8Array;
}): Promise<string> {
  const canonical = [input.method, input.pathname, input.tenantId, input.userId, input.sessionBinding, input.issuedAt].join("\n");
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(input.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonical))).toString("base64url");
}

export async function deterministicConversationId(tenantId: string, projectId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`deviludo-spec\0${tenantId}\0${projectId}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function specOperationKey(input: { tenantId: string; projectId: string; conversationId: string; userId: string; idempotencyKey: string }): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(Object.values(input).join("\0")));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function parseSnapshot(value: unknown, binding: Readonly<Record<string, unknown>>): SpecDialogueSnapshot {
  const body = object(value);
  if (body.tenantId !== binding.tenantId || body.projectId !== binding.projectId || body.conversationId !== binding.conversationId
    || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1 || (body.state !== "DRAFT" && body.state !== "APPROVED")
    || typeof body.specRevisionId !== "string" || !UUID.test(body.specRevisionId)
    || typeof body.testPlanRevisionId !== "string" || !UUID.test(body.testPlanRevisionId)
    || typeof body.specDigest !== "string" || !SHA256.test(body.specDigest)
    || typeof body.testPlanDigest !== "string" || !SHA256.test(body.testPlanDigest)
    || !Array.isArray(body.messages)) invalid();
  const messages: SpecDialogueMessage[] = body.messages.map((value) => {
    const message = object(value);
    if (typeof message.id !== "string" || !UUID.test(message.id) || !Number.isSafeInteger(message.sequence)
      || (message.role !== "assistant" && message.role !== "user") || typeof message.text !== "string"
      || message.text.length < 1 || message.text.length > 4_000 || typeof message.createdAt !== "string"
      || !Number.isFinite(Date.parse(message.createdAt))) invalid();
    return Object.freeze({ id: message.id, sequence: message.sequence as number, role: message.role, text: message.text, createdAt: new Date(message.createdAt).toISOString() });
  });
  return Object.freeze({
    tenantId: body.tenantId as string, projectId: body.projectId as string, conversationId: body.conversationId as string,
    revision: body.revision as number, state: body.state, specRevisionId: body.specRevisionId,
    specDigest: body.specDigest, testPlanRevisionId: body.testPlanRevisionId, testPlanDigest: body.testPlanDigest,
    messages: Object.freeze(messages), result: parseSpecModelResult(body.result),
  });
}
function parseApproval(value: unknown, command: Readonly<Record<string, unknown>>): SpecApprovalReceipt {
  const body = object(value);
  if (body.operationKey !== command.operationKey || body.tenantId !== command.tenantId || body.projectId !== command.projectId
    || body.conversationId !== command.conversationId || body.state !== "APPROVED"
    || !Number.isSafeInteger(body.revision) || body.revision !== (command.expectedRevision as number) + 1
    || typeof body.specRevisionId !== "string" || !UUID.test(body.specRevisionId)
    || typeof body.testPlanRevisionId !== "string" || !UUID.test(body.testPlanRevisionId)
    || typeof body.specDigest !== "string" || !SHA256.test(body.specDigest)
    || typeof body.testPlanDigest !== "string" || !SHA256.test(body.testPlanDigest)
    || !Array.isArray(body.targetMatrix) || typeof body.godotVersion !== "string"
    || typeof body.approvedAt !== "string" || !Number.isFinite(Date.parse(body.approvedAt))) invalid();
  const targetMatrix = body.targetMatrix.map((item) => {
    if (item !== "windows" && item !== "linux" && item !== "macos") invalid();
    return item;
  });
  return Object.freeze({
    operationKey: body.operationKey as string, tenantId: body.tenantId as string, projectId: body.projectId as string,
    conversationId: body.conversationId as string, revision: body.revision as number, state: "APPROVED",
    specRevisionId: body.specRevisionId, specDigest: body.specDigest,
    testPlanRevisionId: body.testPlanRevisionId, testPlanDigest: body.testPlanDigest,
    targetMatrix: Object.freeze(targetMatrix), godotVersion: body.godotVersion,
    approvedAt: new Date(body.approvedAt).toISOString(),
  });
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function header(request: Request, name: string, maximum: number): string { const value = request.headers.get(name); if (!value || value.length > maximum) invalid(); return value; }
function decodeBase64Url(value: string): Uint8Array { try { return Uint8Array.from(Buffer.from(value, "base64url")); } catch { invalid(); } }
function arrayBuffer(value: Uint8Array): ArrayBuffer { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer; }
function invalid(): never { throw new Error("Specification dialogue trust binding is invalid"); }
