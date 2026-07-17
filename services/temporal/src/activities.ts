import type {
  CancelDeliveryInput,
  DeliveryActivities,
  DeliveryActivityReceipt,
  DispatchDeliveryCommandInput,
} from "./contracts";

export type DeliveryDispatchRequest =
  | { readonly kind: "COMMAND"; readonly payload: DispatchDeliveryCommandInput }
  | { readonly kind: "CANCEL"; readonly payload: CancelDeliveryInput };

export interface CommandDispatcher {
  dispatch(request: DeliveryDispatchRequest): Promise<DeliveryActivityReceipt>;
}

export function createDeliveryActivities(dispatcher: CommandDispatcher): DeliveryActivities {
  return {
    async dispatchDeliveryCommand(input) {
      assertDispatchInput(input);
      return dispatcher.dispatch({ kind: "COMMAND", payload: input });
    },
    async cancelDelivery(input) {
      assertDispatchInput(input);
      if (!input.reason.trim()) throw new Error("Cancellation reason is required");
      return dispatcher.dispatch({ kind: "CANCEL", payload: input });
    },
  };
}

export class HttpCommandDispatcher implements CommandDispatcher {
  readonly #endpoint: string;

  constructor(endpoint: string, private readonly timeoutMs = 30_000) {
    const url = new URL(endpoint);
    const allowLocal = process.env.DEVILUDO_ALLOW_INSECURE_LOCAL_DISPATCH === "1";
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Activity dispatch endpoint must not contain credentials, query parameters or fragments");
    }
    if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new Error("Activity dispatch endpoint must use HTTPS");
    }
    this.#endpoint = url.toString();
  }

  async dispatch(request: DeliveryDispatchRequest): Promise<DeliveryActivityReceipt> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": request.payload.idempotencyKey,
          "x-deviludo-workflow-id": request.payload.workflowId,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Activity dispatcher rejected the command with status ${response.status}`);
      const payload: unknown = await response.json();
      if (!isReceipt(payload)) throw new Error("Activity dispatcher returned an invalid receipt");
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
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
      typeof (value as Record<string, unknown>).acceptedAt === "string",
  );
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
