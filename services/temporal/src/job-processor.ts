import type { DeliverySignal } from "./contracts";
import { assertDeliverySignal, type DeliveryCommandDestination } from "./contracts";
import type { ClaimedWorkflowJob } from "./postgres-queue";

export type DeliverySignalWithoutId = DeliverySignal extends infer Signal
  ? Signal extends { signalId: string }
    ? Omit<Signal, "signalId">
    : never
  : never;

export interface WorkflowJobQueuePort {
  claimNext(input: {
    readonly tenantId: string;
    readonly destination: DeliveryCommandDestination;
    readonly workerId: string;
    readonly leaseSeconds?: number;
  }): Promise<ClaimedWorkflowJob | null>;
  renew(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly claimToken: string;
    readonly leaseSeconds?: number;
  }): Promise<string>;
  complete(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly claimToken: string;
    readonly result: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  fail(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly claimToken: string;
    readonly errorCode: string;
    readonly retryAt?: string;
    readonly terminal?: boolean;
  }): Promise<void>;
}

export interface WorkflowJobHandler {
  execute(job: ClaimedWorkflowJob, context: WorkflowJobExecutionContext): Promise<{
    readonly result: Readonly<Record<string, unknown>>;
    readonly signal?: DeliverySignalWithoutId;
  }>;
}

export interface WorkflowJobExecutionContext {
  /** Long-running connectors must call this before the current lease expires. */
  readonly heartbeat: () => Promise<string>;
  /** Emits ordered progress using a phase-stable, replay-safe signal identity. */
  readonly emitSignal: (phase: string, signal: DeliverySignalWithoutId) => Promise<string>;
}

export interface WorkflowSignalPort {
  signal(workflowId: string, signal: DeliverySignal): Promise<void>;
}

export class WorkflowJobError extends Error {
  constructor(
    readonly code: string,
    readonly terminal = false,
  ) {
    super(code);
    if (!/^[A-Z][A-Z0-9_]{2,99}$/.test(code)) throw new Error("Workflow job error code is invalid");
  }
}

export class WorkflowJobProcessor {
  readonly #queue: WorkflowJobQueuePort;
  readonly #handler: WorkflowJobHandler;
  readonly #signals: WorkflowSignalPort;
  readonly #destination: DeliveryCommandDestination;
  readonly #workerId: string;
  readonly #now: () => Date;
  readonly #leaseSeconds: number;
  readonly #maxAttempts: number;

  constructor(options: {
    readonly queue: WorkflowJobQueuePort;
    readonly handler: WorkflowJobHandler;
    readonly signals: WorkflowSignalPort;
    readonly destination: DeliveryCommandDestination;
    readonly workerId: string;
    readonly leaseSeconds?: number;
    readonly maxAttempts?: number;
    readonly now?: () => Date;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(options.workerId)) throw new Error("Workflow worker identity is invalid");
    this.#queue = options.queue;
    this.#handler = options.handler;
    this.#signals = options.signals;
    this.#destination = options.destination;
    this.#workerId = options.workerId;
    this.#leaseSeconds = options.leaseSeconds ?? 300;
    this.#maxAttempts = options.maxAttempts ?? 8;
    if (!Number.isInteger(this.#leaseSeconds) || this.#leaseSeconds < 30 || this.#leaseSeconds > 900) throw new Error("Workflow job lease duration is invalid");
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 20) throw new Error("Workflow job max attempts is invalid");
    this.#now = options.now ?? (() => new Date());
  }

  async processOne(tenantId: string): Promise<
    | { readonly kind: "IDLE" }
    | { readonly kind: "COMPLETED"; readonly jobId: string; readonly signalId: string | null }
    | { readonly kind: "FAILED"; readonly jobId: string; readonly terminal: boolean; readonly errorCode: string }
  > {
    const job = await this.#queue.claimNext({
      tenantId,
      destination: this.#destination,
      workerId: this.#workerId,
      leaseSeconds: this.#leaseSeconds,
    });
    if (!job) return Object.freeze({ kind: "IDLE" as const });
    assertJobBinding(job, tenantId, this.#destination);

    let outcome: Awaited<ReturnType<WorkflowJobHandler["execute"]>>;
    let signalId: string | null = null;
    const emittedSignalIds: string[] = [];
    try {
      outcome = await this.#handler.execute(job, {
        heartbeat: () => this.#queue.renew({
          tenantId: job.tenantId,
          jobId: job.id,
          claimToken: job.claimToken,
          leaseSeconds: this.#leaseSeconds,
        }),
        emitSignal: async (phase, value) => {
          if (!/^[a-z][a-z0-9-]{1,31}$/.test(phase)) throw new WorkflowJobError("INVALID_SIGNAL_PHASE", true);
          const progressSignalId = `job:${job.id}:${phase}`;
          const progressSignal = Object.freeze({ signalId: progressSignalId, ...value }) as DeliverySignal;
          assertDeliverySignal(progressSignal);
          await this.#signals.signal(job.workflowId, progressSignal);
          if (!emittedSignalIds.includes(progressSignalId)) emittedSignalIds.push(progressSignalId);
          return progressSignalId;
        },
      });
      validateResult(outcome.result);
      if (outcome.signal) {
        signalId = `job:${job.id}:final`;
        const signal = Object.freeze({ signalId, ...outcome.signal }) as DeliverySignal;
        assertDeliverySignal(signal);
        await this.#signals.signal(job.workflowId, signal);
      }
    } catch (error) {
      const classified = classify(error, job.attempt, this.#maxAttempts);
      await this.#queue.fail({
        tenantId: job.tenantId,
        jobId: job.id,
        claimToken: job.claimToken,
        errorCode: classified.errorCode,
        terminal: classified.terminal,
        retryAt: classified.terminal ? undefined : retryAt(validNow(this.#now()), job.attempt),
      });
      return Object.freeze({ kind: "FAILED" as const, jobId: job.id, ...classified });
    }

    const result = Object.freeze({
      jobId: job.id,
      workflowId: job.workflowId,
      operation: job.operation,
      requestDigest: job.requestDigest,
      attempt: job.attempt,
      signalId,
      emittedSignalIds: Object.freeze([...emittedSignalIds]),
      output: outcome.result,
    });
    // A lost response here is intentionally not converted into failure: the
    // lease is reclaimed and the idempotent handler/signal are replayed.
    await this.#queue.complete({
      tenantId: job.tenantId,
      jobId: job.id,
      claimToken: job.claimToken,
      result,
    });
    return Object.freeze({ kind: "COMPLETED" as const, jobId: job.id, signalId });
  }
}

function assertJobBinding(job: ClaimedWorkflowJob, tenantId: string, destination: DeliveryCommandDestination): void {
  if (job.tenantId !== tenantId || job.destination !== destination
    || job.request.payload.tenantId !== tenantId || job.request.payload.workflowId !== job.workflowId
    || job.request.payload.projectId !== job.projectId || job.requestDigest.length !== 64) {
    throw new Error("Claimed workflow job processor binding is invalid");
  }
}

function validateResult(value: Readonly<Record<string, unknown>>): void {
  if (!value || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 512 * 1024) {
    throw new WorkflowJobError("INVALID_JOB_RESULT", true);
  }
}

function classify(error: unknown, attempt: number, maxAttempts: number): { terminal: boolean; errorCode: string } {
  if (error instanceof WorkflowJobError) {
    return { terminal: error.terminal || attempt >= maxAttempts, errorCode: error.code };
  }
  return { terminal: attempt >= maxAttempts, errorCode: "WORKFLOW_JOB_EXECUTION_FAILED" };
}

function retryAt(now: Date, attempt: number): string {
  const delayMs = Math.min(15 * 60_000, 5_000 * (2 ** Math.min(8, Math.max(0, attempt - 1))));
  return new Date(now.getTime() + delayMs).toISOString();
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("Workflow job clock is invalid");
  return value;
}
