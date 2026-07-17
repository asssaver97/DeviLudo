import { TLSSocket } from "node:tls";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DeliveryCommandDestination } from "./contracts";
import type { WorkflowCommandReceiver, WorkflowDispatchHeaders } from "./receiver";

export interface WorkflowReceiverRouteOptions {
  readonly destination: DeliveryCommandDestination;
  readonly receiver: WorkflowCommandReceiver;
  /** Must derive identity from mTLS or an equivalently non-forgeable mesh channel. */
  readonly authorize: (request: FastifyRequest) => void | Promise<void>;
  readonly path?: string;
}

export function registerWorkflowCommandRoute(
  server: FastifyInstance,
  options: WorkflowReceiverRouteOptions,
): void {
  server.post(
    options.path ?? "/v1/workflow-commands",
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      try {
        await options.authorize(request);
      } catch {
        return reply.status(401).send({
          error: { code: "WORKLOAD_IDENTITY_REQUIRED", message: "Authorized Temporal workload identity is required" },
        });
      }
      try {
        const headers = dispatchHeaders(request);
        if (headers.destination !== options.destination) {
          throw new Error("Workflow dispatch destination is invalid");
        }
        const receipt = await options.receiver.receive(request.body, headers);
        return reply.status(202).send(receipt);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "Workflow command is already being accepted") {
          return reply.status(503).send({
            error: { code: "WORKFLOW_COMMAND_BUSY", message: "Workflow command acceptance is in progress" },
          });
        }
        if (isRequestError(message)) {
          return reply.status(message.includes("idempotency key was reused") ? 409 : 400).send({
            error: { code: "INVALID_WORKFLOW_COMMAND", message: "Workflow command binding is invalid" },
          });
        }
        return reply.status(503).send({
          error: { code: "WORKFLOW_COMMAND_UNAVAILABLE", message: "Workflow command could not be durably queued" },
        });
      }
    },
  );
}

export function authorizeTemporalWorkerTls(
  request: FastifyRequest,
  allowedSpiffeIds: ReadonlySet<string>,
  at: Date = new Date(),
): void {
  const spiffeId = workflowSpiffeIdFromAuthorizedTls(request, at);
  if (!allowedSpiffeIds.has(spiffeId)) throw new Error("Temporal workload identity is not allowed");
}

export function workflowSpiffeIdFromAuthorizedTls(
  request: FastifyRequest,
  at: Date = new Date(),
): string {
  const socket = request.raw.socket;
  if (!(socket instanceof TLSSocket) || !socket.authorized) {
    throw new Error("Workflow dispatch requires an authorized mutual-TLS socket");
  }
  const peer = socket.getPeerCertificate(false);
  const spiffeId = parseWorkflowSpiffeId(peer.subjectaltname ?? "");
  const expiresAt = Date.parse(peer.valid_to);
  if (!peer.serialNumber || !Number.isFinite(expiresAt) || expiresAt <= at.getTime()) {
    throw new Error("Temporal workload certificate is invalid");
  }
  return spiffeId;
}

export function parseWorkflowSpiffeId(subjectAlternativeName: string): string {
  const spiffeIds = subjectAlternativeName
    .split(/,\s*/)
    .filter((entry) => entry.startsWith("URI:spiffe://"))
    .map((entry) => entry.slice(4));
  if (spiffeIds.length !== 1) throw new Error("Workflow certificate must contain exactly one SPIFFE URI SAN");
  const url = new URL(spiffeIds[0]);
  if (url.protocol !== "spiffe:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Workflow SPIFFE identity is invalid");
  }
  return url.toString();
}

function dispatchHeaders(request: FastifyRequest): WorkflowDispatchHeaders {
  return {
    idempotencyKey: oneHeader(request, "idempotency-key"),
    workflowId: oneHeader(request, "x-deviludo-workflow-id"),
    destination: oneHeader(request, "x-deviludo-destination"),
    operation: oneHeader(request, "x-deviludo-operation"),
  };
}

function oneHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim() || value.length > 1_024) {
    throw new Error("Workflow dispatch transport binding mismatch");
  }
  return value;
}

function isRequestError(message: string): boolean {
  return message.startsWith("Workflow dispatch")
    || message.startsWith("Workflow command")
    || message.startsWith("Workflow cancellation")
    || message.startsWith("Stored workflow receipt")
    || message.startsWith("Workflow idempotency key");
}
