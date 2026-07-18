import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DeliverySignal } from "../../temporal/src/contracts";
import { assertDeliverySignal } from "../../temporal/src/contracts";
import { workflowSpiffeIdFromAuthorizedTls } from "../../temporal/src/receiver-http";
import type {
  WorkflowActionCompletionPort,
  WorkflowActionCompletionSource,
} from "./workflow-action-completion-postgres";
import {
  WorkflowActionCompletionConflictError,
  WorkflowActionCompletionValidationError,
} from "./workflow-action-completion-postgres";

const SOURCES = new Set<WorkflowActionCompletionSource>([
  "SPEC_SERVICE",
  "AGENT_CONFIGURATION_SERVICE",
  "USER_ACCEPTANCE_SERVICE",
  "PROVIDER_MONITOR",
  "MFA_BROKER",
  "STEAM_APPROVAL_MONITOR",
]);

export function registerWorkflowActionCompletionRoute(
  server: FastifyInstance,
  options: {
    readonly store: WorkflowActionCompletionPort;
    readonly authorize: (request: FastifyRequest) => WorkflowActionCompletionSource | Promise<WorkflowActionCompletionSource>;
  },
): void {
  server.post<{ Params: { actionId: string } }>(
    "/v1/workflow-actions/:actionId/complete",
    { bodyLimit: 128 * 1024 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      let source: WorkflowActionCompletionSource;
      try {
        source = await options.authorize(request);
      } catch {
        return reply.status(401).send({
          error: { code: "WORKFLOW_COMPLETION_IDENTITY_REQUIRED", message: "Authorized completion workload identity is required" },
        });
      }
      try {
        const body = objectBody(request.body);
        if ("source" in body || "apiKey" in body || "password" in body || "token" in body) invalid();
        const receipt = await options.store.complete({
          tenantId: stringField(body, "tenantId", 36),
          projectId: stringField(body, "projectId", 36),
          workflowId: stringField(body, "workflowId", 200),
          actionId: request.params.actionId,
          source,
          sourceReceiptId: stringField(body, "sourceReceiptId", 200),
          signal: deliverySignalField(body),
        });
        return reply.status(202).send(receipt);
      } catch (error) {
        const conflict = error instanceof WorkflowActionCompletionConflictError;
        const badRequest = error instanceof WorkflowActionCompletionValidationError;
        return reply.status(conflict ? 409 : badRequest ? 400 : 503).send({
          error: {
            code: conflict ? "WORKFLOW_COMPLETION_CONFLICT" : badRequest
              ? "INVALID_WORKFLOW_COMPLETION" : "WORKFLOW_COMPLETION_UNAVAILABLE",
            message: conflict ? "Workflow action completion conflicts with its authoritative binding"
              : badRequest ? "Workflow action completion is invalid" : "Workflow action completion is unavailable",
          },
        });
      }
    },
  );
}

export function workflowCompletionSourceMapFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<string, WorkflowActionCompletionSource> {
  const encoded = env.DEVILUDO_WORKFLOW_COMPLETION_SPIFFE_SOURCES_JSON;
  if (!encoded || encoded.length > 32 * 1024) throw new Error("Workflow completion SPIFFE source map is required");
  let parsed: unknown;
  try { parsed = JSON.parse(encoded) as unknown; } catch { throw new Error("Workflow completion SPIFFE source map is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidSourceMap();
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.length || entries.length > 50) invalidSourceMap();
  const result = new Map<string, WorkflowActionCompletionSource>();
  for (const [spiffeId, source] of entries) {
    if (!validSpiffeId(spiffeId) || typeof source !== "string"
      || !SOURCES.has(source as WorkflowActionCompletionSource) || result.has(spiffeId)) invalidSourceMap();
    result.set(spiffeId, source as WorkflowActionCompletionSource);
  }
  return result;
}

export function authorizeWorkflowActionCompletionTls(
  request: FastifyRequest,
  sources: ReadonlyMap<string, WorkflowActionCompletionSource>,
): WorkflowActionCompletionSource {
  const source = sources.get(workflowSpiffeIdFromAuthorizedTls(request));
  if (!source) throw new Error("Workflow completion workload identity is not allowed");
  return source;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string, maximum: number): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalid();
  return value;
}

function deliverySignalField(body: Record<string, unknown>): DeliverySignal {
  const value = body.signal;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  try {
    assertDeliverySignal(value as DeliverySignal);
  } catch {
    invalid();
  }
  return value as DeliverySignal;
}

function validSpiffeId(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "spiffe:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function invalid(): never {
  throw new WorkflowActionCompletionValidationError("Workflow action completion binding is invalid");
}

function invalidSourceMap(): never {
  throw new Error("Workflow completion SPIFFE source map is invalid");
}
