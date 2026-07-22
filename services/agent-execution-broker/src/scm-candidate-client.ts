import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import type { AgentCandidatePublisher } from "./operations";
import { createCandidatePublicationRequest, validateCandidatePublicationReceipt } from "../../scm-proxy/src/candidate-publication-contracts";

const MAX_RESPONSE_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+){0,5}$/;

export interface ScmCandidateHttpResponse { readonly statusCode: number; readonly payload: unknown }
export type ScmCandidateHttp = (url: URL, input: Readonly<{ method: "GET" | "POST"; headers: Readonly<Record<string, string>>;
  body?: string; timeoutMs: number; tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }> }>) => Promise<ScmCandidateHttpResponse>;

/** mTLS connector: no GitHub installation token or App private key crosses into the Agent Worker. */
export class MtlsScmCandidatePublisher implements AgentCandidatePublisher {
  readonly #endpoint: URL;
  readonly #tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
  readonly #timeoutMs: number;
  readonly #http: ScmCandidateHttp;

  constructor(options: Readonly<{ endpoint: string | URL; tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
    timeoutMs?: number; http?: ScmCandidateHttp }>) {
    this.#endpoint = endpoint(options.endpoint); validateTls(options.tls); this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 120_000, 1_000, 10 * 60_000); this.#http = options.http ?? httpsJson;
  }

  async publish(input: Parameters<AgentCandidatePublisher["publish"]>[0]) {
    const request = createCandidatePublicationRequest({ tenantId: input.lock.tenantId, projectId: input.lock.projectId,
      runId: input.lock.runId, attemptId: input.attemptId, resolutionDigest: input.lock.resolutionDigest, artifact: input.artifact });
    const response = await this.#http(this.#endpoint, { method: "POST", timeoutMs: this.#timeoutMs, tls: this.#tls,
      headers: Object.freeze({ accept: "application/json", "content-type": "application/json",
        "x-deviludo-tenant-id": request.tenantId, "idempotency-key": request.operationKey,
        "x-deviludo-request-digest": request.requestDigest }), body: JSON.stringify(request) });
    if (response.statusCode !== 200) throw new Error(`SCM candidate Broker rejected publication with status ${response.statusCode}`);
    const receipt = validateCandidatePublicationReceipt(response.payload, request);
    return Object.freeze({ runId: receipt.runId, attemptId: receipt.attemptId, artifactId: receipt.artifactId,
      artifactDigest: receipt.artifactDigest, baseCommitSha: receipt.baseCommitSha,
      candidateCommitSha: receipt.candidateCommitSha, sourceDigest: receipt.sourceDigest,
      draftPullRequest: receipt.draftPullRequest, receiptId: receipt.receiptId });
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href); url.pathname = "/healthz";
    const response = await this.#http(url, { method: "GET", timeoutMs: this.#timeoutMs, tls: this.#tls,
      headers: Object.freeze({ accept: "application/json" }) });
    const body = record(response.payload);
    if (response.statusCode !== 200
      || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([
        "binaryDigest", "schemaVersion", "service", "status", "version",
      ])
      || body.schemaVersion !== "deviludo.scm-candidate-health.v1"
      || body.status !== "ok" || body.service !== "deviludo-scm-candidate-broker"
      || typeof body.version !== "string" || !VERSION.test(body.version) || /latest|stable|default/i.test(body.version)
      || typeof body.binaryDigest !== "string" || !SHA256.test(body.binaryDigest)) {
      throw new Error("SCM candidate Broker readiness probe failed");
    }
  }
}

export async function scmCandidatePublisherFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Promise<MtlsScmCandidatePublisher> {
  const [key, certificate, ca] = await Promise.all([read(env, "DEVILUDO_SCM_CANDIDATE_BROKER_TLS_KEY_FILE"),
    read(env, "DEVILUDO_SCM_CANDIDATE_BROKER_TLS_CERT_FILE"), read(env, "DEVILUDO_SCM_CANDIDATE_BROKER_CA_FILE")]);
  return new MtlsScmCandidatePublisher({ endpoint: required(env, "DEVILUDO_SCM_CANDIDATE_BROKER_URL"),
    tls: { key, certificate, ca }, timeoutMs: integer(Number(env.DEVILUDO_SCM_CANDIDATE_BROKER_TIMEOUT_MS ?? "120000"), 1_000, 600_000) });
}

async function httpsJson(url: URL, input: Parameters<ScmCandidateHttp>[1]): Promise<ScmCandidateHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...input.headers }; if (input.body !== undefined) headers["content-length"] = String(Buffer.byteLength(input.body));
    const options: RequestOptions = { method: input.method, headers, key: input.tls.key, cert: input.tls.certificate,
      ca: input.tls.ca, rejectUnauthorized: true, minVersion: "TLSv1.3", servername: url.hostname };
    const request = httpsRequest(url, options, (response) => { const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) response.destroy(new Error("response too large")); else chunks.push(value); });
      response.once("error", reject); response.once("end", () => { try { resolve({ statusCode: response.statusCode ?? 503,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }); } catch { reject(new Error("invalid JSON")); } }); });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("SCM candidate Broker timed out")));
    request.once("error", reject); request.end(input.body);
  });
}
function endpoint(value: string | URL): URL { const url = new URL(value.toString()); if (url.protocol !== "https:" || url.username || url.password
  || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1/candidates") throw new Error("SCM candidate Broker endpoint is invalid");
  url.pathname = "/v1/candidates"; return url; }
function validateTls(value: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>): void { if ([value.key, value.certificate, value.ca].some((item) => !Buffer.isBuffer(item) || item.byteLength < 32 || item.byteLength > 1024 * 1024)) throw new Error("SCM candidate TLS is invalid"); }
async function read(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name); if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size < 32 || stat.size > 1024 * 1024) throw new Error(`${name} is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integer(value: number, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("SCM candidate integer is invalid"); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SCM candidate response is invalid"); return value as Record<string, unknown>; }
