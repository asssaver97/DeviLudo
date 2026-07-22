import { request as httpsRequest, type RequestOptions } from "node:https";
import type { SpecApprovalCommand, SpecApprovalReceipt } from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const WORKFLOW_ID = /^delivery-[a-f0-9-]{36}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface SpecWorkflowApprovalSink {
  probe(): Promise<void>;
  publish(command: SpecApprovalCommand, receipt: SpecApprovalReceipt): Promise<void>;
}

export interface SpecWorkflowBridgeTls {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}
export interface SpecWorkflowBridgeHttpResponse { readonly statusCode: number; readonly payload: unknown }
export type SpecWorkflowBridgeHttp = (
  url: URL,
  input: {
    readonly method?: "GET" | "POST";
    readonly body: string;
    readonly operationKey: string | null;
    readonly timeoutMs: number;
    readonly tls: SpecWorkflowBridgeTls;
  },
) => Promise<SpecWorkflowBridgeHttpResponse>;

/** Publishes only the already-committed approval authority over fixed mTLS. */
export class MtlsSpecWorkflowApprovalSink implements SpecWorkflowApprovalSink {
  readonly #endpoint: URL;
  readonly #tls: SpecWorkflowBridgeTls;
  readonly #timeoutMs: number;
  readonly #http: SpecWorkflowBridgeHttp;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: SpecWorkflowBridgeTls;
    readonly timeoutMs?: number;
    readonly http?: SpecWorkflowBridgeHttp;
  }) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== "/v1/spec-approvals") {
      throw new Error("Specification workflow Bridge endpoint is invalid");
    }
    if (options.tls.key.byteLength < 32 || options.tls.certificate.byteLength < 32
      || options.tls.ca.byteLength < 32) throw new Error("Specification workflow Bridge TLS material is invalid");
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("Specification workflow Bridge timeout is invalid");
    }
    this.#endpoint = endpoint;
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = timeoutMs;
    this.#http = options.http ?? specWorkflowBridgeHttpsJson;
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href);
    url.pathname = "/healthz";
    const response = await this.#http(url, {
      method: "GET", body: "", operationKey: null, timeoutMs: this.#timeoutMs, tls: this.#tls,
    });
    const body = record(response.payload);
    if (response.statusCode !== 200 || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["service", "status"])
      || body.status !== "ok" || body.service !== "deviludo-spec-workflow-bridge") {
      throw new Error("Specification workflow Bridge health identity is invalid");
    }
  }

  async publish(command: SpecApprovalCommand, receipt: SpecApprovalReceipt): Promise<void> {
    if (receipt.operationKey !== command.operationKey || receipt.tenantId !== command.tenantId
      || receipt.projectId !== command.projectId || receipt.conversationId !== command.conversationId
      || receipt.state !== "APPROVED") throw new Error("Specification workflow approval receipt drifted");
    const body = JSON.stringify({
      schemaVersion: "deviludo.spec-workflow-approval.v1",
      operationKey: receipt.operationKey,
      tenantId: receipt.tenantId,
      projectId: receipt.projectId,
      conversationId: receipt.conversationId,
      draftSpecRevisionId: command.specRevisionId,
      draftTestPlanRevisionId: command.testPlanRevisionId,
      approvedSpecRevisionId: receipt.specRevisionId,
      approvedSpecDigest: receipt.specDigest,
      approvedTestPlanRevisionId: receipt.testPlanRevisionId,
      approvedTestPlanDigest: receipt.testPlanDigest,
      targetMatrix: receipt.targetMatrix,
      godotVersion: receipt.godotVersion,
      approvedAt: receipt.approvedAt,
    });
    const response = await this.#http(this.#endpoint, {
      body, operationKey: receipt.operationKey, timeoutMs: this.#timeoutMs, tls: this.#tls,
    });
    if (response.statusCode !== 200 && response.statusCode !== 202) {
      throw new Error("Specification workflow Bridge did not accept the approval");
    }
    const envelope = record(response.payload);
    if (JSON.stringify(Object.keys(envelope)) !== JSON.stringify(["data"])) invalid();
    const data = record(envelope.data);
    if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify([
      "approvalEventKey", "readyEventKey", "replayed", "state", "workflowId",
    ])) invalid();
    if (!WORKFLOW_ID.test(text(data.workflowId))
      || (data.readyEventKey !== null && !SHA256.test(text(data.readyEventKey)))
      || !SHA256.test(text(data.approvalEventKey))
      || (data.state !== "PENDING_DELIVERY" && data.state !== "DELIVERED")
      || typeof data.replayed !== "boolean") invalid();
  }
}

export function specWorkflowBridgeHttpsJson(
  url: URL,
  input: {
    readonly method?: "GET" | "POST";
    readonly body: string;
    readonly operationKey: string | null;
    readonly timeoutMs: number;
    readonly tls: SpecWorkflowBridgeTls;
  },
): Promise<SpecWorkflowBridgeHttpResponse> {
  return new Promise((resolve, reject) => {
    const method = input.method ?? "POST";
    if (method === "POST" && !input.operationKey) {
      reject(new Error("Specification workflow Bridge operation key is required"));
      return;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(input.body));
      headers["idempotency-key"] = input.operationKey!;
    }
    const options: RequestOptions = {
      method,
      headers,
      key: input.tls.key, cert: input.tls.certificate, ca: input.tls.ca,
      rejectUnauthorized: true, minVersion: "TLSv1.3", servername: url.hostname,
    };
    const request = httpsRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Specification workflow Bridge response exceeded the limit"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 503,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          }));
        } catch { reject(new Error("Specification workflow Bridge returned invalid JSON")); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Specification workflow Bridge timed out")));
    request.once("error", reject);
    request.end(method === "POST" ? input.body : undefined);
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function invalid(): never { throw new Error("Specification workflow Bridge response binding is invalid"); }
