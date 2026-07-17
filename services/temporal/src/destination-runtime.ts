import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DeliveryCommandDestination } from "./contracts";
import {
  WorkflowJobProcessor,
  type WorkflowJobHandler,
  type WorkflowJobQueuePort,
  type WorkflowSignalPort,
} from "./job-processor";
import {
  WorkflowJobWorkerHost,
  type WorkflowTenantAssignmentSource,
  type WorkflowJobProcessorPort,
  type WorkflowWorkerHostDiagnostic,
} from "./job-worker-host";
import { PostgresWorkflowCommandInbox, type PostgresWorkflowPool } from "./postgres-inbox";
import { PostgresWorkflowCommandQueue } from "./postgres-queue";
import { WorkflowCommandReceiver, type WorkflowCommandHandler, type WorkflowCommandInbox } from "./receiver";
import { registerWorkflowCommandRoute } from "./receiver-http";

export type WorkflowDestinationRuntimeState =
  | "STARTING"
  | "READY"
  | "DRAINING"
  | "STOPPED"
  | "FAILED";

export interface WorkflowDestinationQueue extends WorkflowCommandHandler, WorkflowJobQueuePort {}

export interface WorkflowDestinationRuntimeDiagnostic {
  readonly code:
    | WorkflowWorkerHostDiagnostic["code"]
    | "DEPENDENCY_PROBE_FAILED"
    | "WORKER_HOST_STOPPED";
  readonly destination: DeliveryCommandDestination;
}

export class WorkflowDestinationRuntime {
  readonly #server: FastifyInstance;
  readonly #workers: readonly WorkflowJobWorkerHost[];
  readonly #destination: DeliveryCommandDestination;
  readonly #probes: readonly (() => Promise<void>)[];
  readonly #onDiagnostic: (diagnostic: WorkflowDestinationRuntimeDiagnostic) => void;
  readonly #abort = new AbortController();
  #state: WorkflowDestinationRuntimeState = "STOPPED";
  #workerPromise: Promise<void> | null = null;
  #workerFailure: unknown = null;

  constructor(options: {
    readonly server: FastifyInstance;
    readonly workers: readonly WorkflowJobWorkerHost[];
    readonly destination: DeliveryCommandDestination;
    readonly probes?: readonly (() => Promise<void>)[];
    readonly onDiagnostic?: (diagnostic: WorkflowDestinationRuntimeDiagnostic) => void;
  }) {
    this.#server = options.server;
    if (!options.workers.length || options.workers.length > 10) {
      throw new Error("Workflow destination runtime worker set is invalid");
    }
    this.#workers = Object.freeze([...options.workers]);
    this.#destination = options.destination;
    this.#probes = Object.freeze([...(options.probes ?? [])]);
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#registerHealthRoute();
  }

  get state(): WorkflowDestinationRuntimeState {
    return this.#state;
  }

  async start(openServer: () => Promise<unknown>): Promise<void> {
    if (this.#state !== "STOPPED" || this.#workerPromise) {
      throw new Error("Workflow destination runtime is already started");
    }
    this.#state = "STARTING";
    try {
      for (const probe of this.#probes) await probe();
      if (this.#abort.signal.aborted) throw new Error("Workflow destination runtime was stopped during startup");
      await openServer();
      this.#state = "READY";
      this.#workerPromise = Promise.all(this.#workers.map((worker) => worker.run(this.#abort.signal)
        .then(() => this.#workerStopped())
        .catch((error: unknown) => this.#workerStopped(error)))).then(() => undefined);
    } catch (error) {
      this.#state = "FAILED";
      this.#diagnostic("DEPENDENCY_PROBE_FAILED");
      await this.#server.close().catch(() => undefined);
      throw error;
    }
  }

  async wait(): Promise<void> {
    if (!this.#workerPromise) throw new Error("Workflow destination runtime has not started");
    await this.#workerPromise;
    if (this.#workerFailure) throw new Error("Workflow destination worker stopped unexpectedly");
  }

  async stop(): Promise<void> {
    if (this.#state === "STOPPED") return;
    if (this.#state !== "FAILED") this.#state = "DRAINING";
    this.#abort.abort();
    if (this.#workerPromise) await this.#workerPromise;
    await this.#server.close();
    this.#state = "STOPPED";
  }

  #registerHealthRoute(): void {
    this.#server.get("/healthz", async (_request, reply) => {
      reply.header("cache-control", "no-store");
      const ready = this.#state === "READY";
      return reply.status(ready ? 200 : 503).send(Object.freeze({
        service: "deviludo-workflow-destination",
        destination: this.#destination,
        state: this.#state,
        ready,
      }));
    });
  }

  #diagnostic(code: WorkflowDestinationRuntimeDiagnostic["code"]): void {
    try {
      this.#onDiagnostic(Object.freeze({ code, destination: this.#destination }));
    } catch {
      // Telemetry cannot terminate the receiver or worker host.
    }
  }

  #workerStopped(error?: unknown): void {
    if (this.#abort.signal.aborted) return;
    this.#workerFailure = error ?? new Error("Workflow destination worker stopped unexpectedly");
    this.#state = "FAILED";
    this.#diagnostic("WORKER_HOST_STOPPED");
    this.#abort.abort();
  }
}

export function createWorkflowDestinationRuntime(options: {
  readonly server: FastifyInstance;
  readonly destination: DeliveryCommandDestination;
  readonly workerId: string;
  readonly pool?: PostgresWorkflowPool;
  readonly inbox?: WorkflowCommandInbox;
  readonly queue?: WorkflowDestinationQueue;
  readonly handler: WorkflowJobHandler;
  readonly signals: WorkflowSignalPort;
  readonly tenants: WorkflowTenantAssignmentSource;
  readonly auxiliaryProcessors?: readonly WorkflowJobProcessorPort[];
  readonly authorize: (request: FastifyRequest) => void | Promise<void>;
  readonly probes?: readonly (() => Promise<void>)[];
  readonly onDiagnostic?: (diagnostic: WorkflowDestinationRuntimeDiagnostic) => void;
}): WorkflowDestinationRuntime {
  if ((!options.pool && (!options.inbox || !options.queue))
    || (options.pool && (options.inbox || options.queue))) {
    throw new Error("Workflow destination persistence configuration is invalid");
  }
  const inbox = options.inbox ?? new PostgresWorkflowCommandInbox(options.pool as PostgresWorkflowPool);
  const queue = options.queue ?? new PostgresWorkflowCommandQueue(options.pool as PostgresWorkflowPool);
  const receiver = new WorkflowCommandReceiver(options.destination, inbox, queue);
  registerWorkflowCommandRoute(options.server, {
    destination: options.destination,
    receiver,
    authorize: options.authorize,
  });
  const processor = new WorkflowJobProcessor({
    queue,
    handler: options.handler,
    signals: options.signals,
    destination: options.destination,
    workerId: options.workerId,
  });
  const worker = new WorkflowJobWorkerHost({
    processor,
    tenants: options.tenants,
    destination: options.destination,
    onDiagnostic: options.onDiagnostic,
  });
  const auxiliaryWorkers = (options.auxiliaryProcessors ?? []).map((processor) => new WorkflowJobWorkerHost({
    processor,
    tenants: options.tenants,
    destination: options.destination,
    onDiagnostic: options.onDiagnostic,
  }));
  return new WorkflowDestinationRuntime({
    server: options.server,
    workers: [worker, ...auxiliaryWorkers],
    destination: options.destination,
    probes: options.probes,
    onDiagnostic: options.onDiagnostic,
  });
}
