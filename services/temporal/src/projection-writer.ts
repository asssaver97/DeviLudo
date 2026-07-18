import { request as httpsRequest, type RequestOptions } from "node:https";
import { readFile } from "node:fs/promises";
import type {
  DeliveryProjectionReceipt,
  DeliveryProjectionRequest,
} from "../../../lib/orchestration/delivery-projection";
import type { DeliveryProjectionWriter } from "./activities";
import type { WorkflowDispatchTlsMaterial } from "./mtls-dispatcher";

const MAX_RESPONSE_BYTES = 64 * 1024;

export class HttpDeliveryProjectionWriter implements DeliveryProjectionWriter {
  readonly #endpoint: URL;
  constructor(endpoint: string, private readonly timeoutMs = 30_000, private readonly fetcher: typeof fetch = fetch) {
    this.#endpoint = projectionEndpoint(endpoint, true);
    validTimeout(timeoutMs);
  }

  async persist(request: DeliveryProjectionRequest): Promise<DeliveryProjectionReceipt> {
    const response = await this.fetcher(this.#endpoint, {
      method: "POST",
      redirect: "error",
      headers: projectionHeaders(request),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Delivery projection service rejected the snapshot with status ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Delivery projection receipt exceeded the response limit");
    return receipt(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  }
}

export class MtlsDeliveryProjectionWriter implements DeliveryProjectionWriter {
  readonly #endpoint: URL;
  constructor(
    endpoint: string,
    private readonly tls: WorkflowDispatchTlsMaterial,
    private readonly timeoutMs = 30_000,
  ) {
    this.#endpoint = projectionEndpoint(endpoint, false);
    validTimeout(timeoutMs);
    for (const entry of [tls.key, tls.certificate, tls.ca]) {
      if (!Buffer.isBuffer(entry) || entry.byteLength < 32 || entry.byteLength > 1024 * 1024) {
        throw new Error("Delivery projection TLS material is invalid");
      }
    }
  }

  persist(input: DeliveryProjectionRequest): Promise<DeliveryProjectionReceipt> {
    const body = JSON.stringify(input);
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        method: "POST",
        headers: { ...projectionHeaders(input), "content-length": String(Buffer.byteLength(body)) },
        key: this.tls.key,
        cert: this.tls.certificate,
        ca: this.tls.ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        servername: this.#endpoint.hostname,
      };
      const outgoing = httpsRequest(this.#endpoint, options, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Delivery projection receipt exceeded the response limit"));
            return;
          }
          chunks.push(value);
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            if ((response.statusCode ?? 503) < 200 || (response.statusCode ?? 503) > 299) {
              reject(new Error(`Delivery projection service rejected the snapshot with status ${response.statusCode ?? 503}`));
              return;
            }
            resolve(receipt(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown));
          } catch (error) { reject(error); }
        });
      });
      outgoing.setTimeout(this.timeoutMs, () => outgoing.destroy(new Error("Delivery projection request timed out")));
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  }
}

export async function mtlsDeliveryProjectionWriterFromEnv(
  endpoint: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsDeliveryProjectionWriter> {
  const [key, certificate, ca] = await Promise.all([
    pem(env, "DEVILUDO_TEMPORAL_DISPATCH_TLS_KEY_FILE"),
    pem(env, "DEVILUDO_TEMPORAL_DISPATCH_TLS_CERT_FILE"),
    pem(env, "DEVILUDO_TEMPORAL_DISPATCH_CA_FILE"),
  ]);
  return new MtlsDeliveryProjectionWriter(endpoint, { key, certificate, ca });
}

export function deliveryProjectionEndpointFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const endpoint = env.DEVILUDO_DELIVERY_PROJECTION_URL?.trim();
  if (!endpoint) throw new Error("DEVILUDO_DELIVERY_PROJECTION_URL is required");
  return endpoint;
}

function projectionEndpoint(value: string, allowExplicitLocal: boolean): URL {
  const url = new URL(value);
  const local = allowExplicitLocal && process.env.DEVILUDO_ALLOW_INSECURE_LOCAL_DISPATCH === "1"
    && url.protocol === "http:" && isLoopback(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash
    || url.pathname !== "/v1/delivery-projections") {
    throw new Error("Delivery projection endpoint must be the credential-free projection HTTPS route");
  }
  return url;
}

function projectionHeaders(request: DeliveryProjectionRequest): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": request.projectionKey,
    "x-deviludo-workflow-id": request.snapshot.workflowId,
  });
}

function receipt(value: unknown): DeliveryProjectionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidReceipt();
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).length !== 1 || !("data" in envelope)
    || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) invalidReceipt();
  return Object.freeze({ ...(envelope.data as DeliveryProjectionReceipt) });
}

async function pem(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = env[name]?.trim();
  if (!path || !path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} is required as an absolute path`);
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) throw new Error(`${name} file is invalid`);
  return value;
}

function validTimeout(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 600_000) throw new Error("Delivery projection timeout is invalid");
}
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
function invalidReceipt(): never { throw new Error("Delivery projection service returned an invalid receipt"); }
