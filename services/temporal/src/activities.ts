import type {
  CancelDeliveryInput,
  DeliveryCommandDestination,
  DeliveryActivities,
  DeliveryActivityReceipt,
  DispatchDeliveryCommandInput,
} from "./contracts";
import { deliveryCommandDestination } from "./contracts";
import {
  parseDeliveryProjectionRequest,
  type DeliveryProjectionReceipt,
  type DeliveryProjectionRequest,
} from "../../../lib/orchestration/delivery-projection";

export type DeliveryDispatchRequest =
  | {
      readonly kind: "COMMAND";
      readonly destination: DeliveryCommandDestination;
      readonly payload: DispatchDeliveryCommandInput;
    }
  | {
      readonly kind: "CANCEL";
      readonly destination: "control-plane";
      readonly payload: CancelDeliveryInput;
    };

export type DeliveryDispatchEndpoints = Readonly<
  Record<DeliveryCommandDestination, string>
>;

export interface CommandDispatcher {
  dispatch(request: DeliveryDispatchRequest): Promise<DeliveryActivityReceipt>;
}

export interface DeliveryProjectionWriter {
  persist(request: DeliveryProjectionRequest): Promise<DeliveryProjectionReceipt>;
}

export function createDeliveryActivities(
  dispatcher: CommandDispatcher,
  projections: DeliveryProjectionWriter,
): DeliveryActivities {
  return {
    async dispatchDeliveryCommand(input) {
      assertDispatchInput(input);
      const destination = deliveryCommandDestination(input.command);
      if (input.destination !== destination) {
        throw new Error("Activity command destination mismatch");
      }
      const request = { kind: "COMMAND", destination, payload: input } as const;
      return assertReceiptBinding(await dispatcher.dispatch(request), request);
    },
    async cancelDelivery(input) {
      assertDispatchInput(input);
      if (!input.reason.trim()) throw new Error("Cancellation reason is required");
      if (input.destination !== "control-plane") {
        throw new Error("Cancellation must be routed through the control plane");
      }
      const request = { kind: "CANCEL", destination: "control-plane", payload: input } as const;
      return assertReceiptBinding(await dispatcher.dispatch(request), request);
    },
    async persistDeliverySnapshot(input) {
      const request = parseDeliveryProjectionRequest(input);
      return assertProjectionReceipt(await projections.persist(request), request);
    },
  };
}

export class HttpCommandDispatcher implements CommandDispatcher {
  readonly #endpoints: Readonly<Record<DeliveryCommandDestination, string>>;

  constructor(endpoints: DeliveryDispatchEndpoints, private readonly timeoutMs = 30_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new Error("Activity dispatch timeout is invalid");
    }
    this.#endpoints = Object.freeze({
      "control-plane": validateEndpoint(endpoints["control-plane"]),
      "agent-worker": validateEndpoint(endpoints["agent-worker"]),
      "runner-control": validateEndpoint(endpoints["runner-control"]),
      "scm-proxy": validateEndpoint(endpoints["scm-proxy"]),
      "steam-publisher": validateEndpoint(endpoints["steam-publisher"]),
    });
  }

  async dispatch(request: DeliveryDispatchRequest): Promise<DeliveryActivityReceipt> {
    if (request.destination !== request.payload.destination) {
      throw new Error("Activity dispatch envelope destination mismatch");
    }
    const endpoint = this.#endpoints[request.destination];
    const operation = request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": request.payload.idempotencyKey,
          "x-deviludo-destination": request.destination,
          "x-deviludo-operation": operation,
          "x-deviludo-workflow-id": request.payload.workflowId,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Activity dispatcher rejected the command with status ${response.status}`);
      const payload = await readJsonResponse(response);
      if (!isReceipt(payload)) throw new Error("Activity dispatcher returned an invalid receipt");
      return assertReceiptBinding(payload, request);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function deliveryDispatchEndpointsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeliveryDispatchEndpoints {
  return Object.freeze({
    "control-plane": requiredEnv(env, "DEVILUDO_CONTROL_PLANE_DISPATCH_URL"),
    "agent-worker": requiredEnv(env, "DEVILUDO_AGENT_WORKER_DISPATCH_URL"),
    "runner-control": requiredEnv(env, "DEVILUDO_RUNNER_CONTROL_DISPATCH_URL"),
    "scm-proxy": requiredEnv(env, "DEVILUDO_SCM_PROXY_DISPATCH_URL"),
    "steam-publisher": requiredEnv(env, "DEVILUDO_STEAM_PUBLISHER_DISPATCH_URL"),
  });
}

function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const allowLocal = process.env.DEVILUDO_ALLOW_INSECURE_LOCAL_DISPATCH === "1";
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Activity dispatch endpoint must not contain credentials, query parameters or fragments");
  }
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Activity dispatch endpoint must use HTTPS");
  }
  return url.toString();
}

function assertDispatchInput(input: DispatchDeliveryCommandInput | CancelDeliveryInput): void {
  if (!input.idempotencyKey || !input.workflowId || !input.tenantId || !input.projectId) {
    throw new Error("Activity input is missing its immutable workflow binding");
  }
  if (input.snapshot.workflowId !== input.workflowId || input.snapshot.tenantId !== input.tenantId || input.snapshot.projectId !== input.projectId) {
    throw new Error("Activity snapshot binding mismatch");
  }
}

function isReceipt(value: unknown): value is DeliveryActivityReceipt {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).receiptId === "string" &&
      typeof (value as Record<string, unknown>).acceptedAt === "string" &&
      typeof (value as Record<string, unknown>).destination === "string" &&
      typeof (value as Record<string, unknown>).workflowId === "string" &&
      typeof (value as Record<string, unknown>).idempotencyKey === "string" &&
      typeof (value as Record<string, unknown>).operation === "string",
  );
}

function assertReceiptBinding(
  receipt: DeliveryActivityReceipt,
  request: DeliveryDispatchRequest,
): DeliveryActivityReceipt {
  const operation = request.kind === "COMMAND" ? request.payload.command : "CANCEL_DELIVERY";
  if (
    !receipt.receiptId.trim() ||
    !Number.isFinite(Date.parse(receipt.acceptedAt)) ||
    receipt.destination !== request.destination ||
    receipt.workflowId !== request.payload.workflowId ||
    receipt.idempotencyKey !== request.payload.idempotencyKey ||
    receipt.operation !== operation
  ) {
    throw new Error("Activity receipt binding mismatch");
  }
  return Object.freeze({ ...receipt });
}

function assertProjectionReceipt(
  receipt: DeliveryProjectionReceipt,
  request: DeliveryProjectionRequest,
): DeliveryProjectionReceipt {
  if (!receipt || !receipt.receiptId?.trim() || !Number.isFinite(Date.parse(receipt.acceptedAt))
    || receipt.projectionKey !== request.projectionKey
    || receipt.workflowId !== request.snapshot.workflowId
    || receipt.sequence !== request.snapshot.history.length
    || receipt.state !== request.snapshot.state
    || !/^[a-f0-9]{64}$/.test(receipt.snapshotDigest)
    || typeof receipt.replayed !== "boolean") {
    throw new Error("Delivery projection receipt binding mismatch");
  }
  return Object.freeze({ ...receipt });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const maximumBytes = 64 * 1024;
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) {
    throw new Error("Activity dispatcher receipt exceeded the response limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new Error("Activity dispatcher receipt exceeded the response limit");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Activity dispatcher returned invalid JSON");
  }
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
