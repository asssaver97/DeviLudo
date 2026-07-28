import type { MacCapacityEvent } from "./capacity-events";
import { parseMacCapacityEvent } from "./capacity-events";
import { readShortLivedCredentials, signAwsJsonRequest, strictQueueUrl } from "./aws-sqs-capacity";

export interface MacCapacityEventEnvelope {
  readonly messageId: string;
  readonly event: MacCapacityEvent;
  ack(): Promise<void>;
}

export class AwsSqsFifoCapacityEventSource {
  readonly #queueUrl: URL;
  readonly #region: string;
  readonly #credentialsFile: string;
  readonly #fetch: typeof fetch;

  constructor(options: Readonly<{ queueUrl: string; region: string; credentialsFile: string; fetch?: typeof fetch }>) {
    this.#queueUrl = strictQueueUrl(options.queueUrl, options.region);
    this.#region = options.region;
    this.#credentialsFile = options.credentialsFile;
    this.#fetch = options.fetch ?? fetch;
  }

  async receiveOne(): Promise<MacCapacityEventEnvelope | null> {
    const response = await this.#request("AmazonSQS.ReceiveMessage", {
      QueueUrl: this.#queueUrl.href, MaxNumberOfMessages: 1, WaitTimeSeconds: 5, VisibilityTimeout: 60,
    });
    const message = (response.Messages as readonly Record<string, unknown>[] | undefined)?.[0];
    if (!message) return null;
    const messageId = String(message.MessageId ?? "");
    const receiptHandle = String(message.ReceiptHandle ?? "");
    if (!/^[A-Za-z0-9-]{8,128}$/.test(messageId) || receiptHandle.length < 16 || receiptHandle.length > 8_192
      || /[\0\r\n]/.test(receiptHandle) || typeof message.Body !== "string") {
      throw new Error("AWS Mac capacity event envelope is invalid");
    }
    const event = parseMacCapacityEvent(message.Body);
    let acknowledged = false;
    return Object.freeze({
      messageId, event,
      ack: async () => {
        if (acknowledged) return;
        await this.#request("AmazonSQS.DeleteMessage", { QueueUrl: this.#queueUrl.href, ReceiptHandle: receiptHandle });
        acknowledged = true;
      },
    });
  }

  async #request(target: string, payload: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const credentials = await readShortLivedCredentials(this.#credentialsFile);
    const body = JSON.stringify(payload);
    const endpoint = new URL(`https://sqs.${this.#region}.amazonaws.com/`);
    const headers = signAwsJsonRequest({ method: "POST", url: endpoint, region: this.#region, service: "sqs", body, credentials, at: new Date(), target });
    const response = await this.#fetch(endpoint, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok || response.redirected) throw new Error("AWS Mac capacity event request failed");
    return await response.json() as Record<string, unknown>;
  }
}
