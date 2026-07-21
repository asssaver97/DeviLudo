import {
  canonicalDeliveryJson,
  parseDeliverySnapshot,
} from "@/lib/orchestration/delivery-projection";
import type { DeliveryProjectionView } from "@/services/delivery-projection/src/store";
import { parseRunnerFleetProjection, type RunnerFleetProjection } from "@/lib/runner/fleet-projection";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_RESPONSE_BYTES = 4_500_000;

/**
 * The production Web workload reaches this Broker through its service-mesh
 * mTLS identity. No database credentials or Temporal query authority enter
 * the Web process.
 */
export class DeliveryProjectionBrokerClient {
  readonly #origin: URL;
  constructor(endpoint: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("Delivery projection Broker endpoint is invalid");
    }
    this.#origin = url;
  }

  async read(input: { readonly tenantId: string; readonly projectId: string }): Promise<DeliveryProjectionView> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.projectId)) throw new Error("Delivery projection read binding is invalid");
    const response = await this.fetcher(new URL(`/v1/delivery-projections/${encodeURIComponent(input.projectId)}`, this.#origin), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", "x-deviludo-tenant-id": input.tenantId },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200) throw new DeliveryProjectionBrokerError(response.status);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) invalid();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) invalid();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { invalid(); }
    const envelope = object(value);
    if (Object.keys(envelope).length !== 1) invalid();
    const view = object(envelope.data);
    if (Object.keys(view).sort().join(",") !== "projectedAt,snapshot,snapshotDigest") invalid();
    const snapshot = parseDeliverySnapshot(view.snapshot);
    if (snapshot.tenantId !== input.tenantId || snapshot.projectId !== input.projectId
      || typeof view.snapshotDigest !== "string" || !SHA256.test(view.snapshotDigest)
      || view.snapshotDigest !== await sha256(canonicalDeliveryJson(snapshot))
      || typeof view.projectedAt !== "string" || !Number.isFinite(Date.parse(view.projectedAt))) invalid();
    return Object.freeze({
      snapshot,
      snapshotDigest: view.snapshotDigest,
      projectedAt: new Date(view.projectedAt).toISOString(),
    });
  }

  async readRunnerFleet(input: { readonly tenantId: string; readonly projectId: string }): Promise<RunnerFleetProjection> {
    if (!UUID.test(input.tenantId) || !UUID.test(input.projectId)) throw new Error("Runner fleet read binding is invalid");
    const response = await this.fetcher(new URL(`/v1/runner-fleet/${encodeURIComponent(input.projectId)}`, this.#origin), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", "x-deviludo-tenant-id": input.tenantId },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200) throw new DeliveryProjectionBrokerError(response.status);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) invalid();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) invalid();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { invalid(); }
    const envelope = object(value);
    if (Object.keys(envelope).length !== 1) invalid();
    try { return parseRunnerFleetProjection(envelope.data, input); }
    catch { invalid(); }
  }
}

export class DeliveryProjectionBrokerError extends Error {
  constructor(readonly status: number) { super(`Delivery projection Broker rejected the read with status ${status}`); }
}

export function deliveryProjectionBrokerFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeliveryProjectionBrokerClient | null {
  const endpoint = env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL?.trim();
  return endpoint ? new DeliveryProjectionBrokerClient(endpoint) : null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new Error("Delivery projection Broker response binding is invalid"); }
