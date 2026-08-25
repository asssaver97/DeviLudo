import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AgentModelOverrides, AgentRuntimeKind, WorkspaceSummary } from "@/lib/product/contracts";

/**
 * DeviLudo is a self-hosted, single-operator application. These stable opaque
 * identifiers keep workflow ownership and RLS boundaries deterministic while
 * the application remains a single local instance.
 */
export const LOCAL_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";

export const CORE_CAPABILITIES = Object.freeze([
  "project.read",
  "project.write",
  "project.delete",
  "artifact.download",
  "steam.manage",
  "instance.agent.manage",
  "instance.runtime.manage",
] as const);

export type CoreCapability = typeof CORE_CAPABILITIES[number];

export type CorePrincipal = Readonly<{
  actorId: string;
  actorLabel: string;
  workspace: WorkspaceSummary;
  capabilities: readonly CoreCapability[];
}>;

export type CoreAgentRuntime = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  primaryModel: string;
  modelOverrides: AgentModelOverrides;
  imageModel: string | null;
  apiKey: string;
}>;

export type CoreAdmissionOperation = "AGENT" | "SANDBOX" | "E2E" | "BUILD" | "STEAM_PUBLISH";
export type CoreAdmission = Readonly<{ reservationId: string | null }>;

/** Generic embedding boundary. Platform account and billing types stay outside Core. */
export interface CoreHostServices {
  readonly mode: "self-hosted" | "managed";
  readonly access: Readonly<{
    resolvePrincipal(request: FastifyRequest, forceRefresh: boolean): Promise<CorePrincipal>;
  }>;
  readonly agent: Readonly<{
    resolveRuntime(input: Readonly<{
      principal: CorePrincipal;
      workload: "conversation" | "design" | "development" | "test" | "image";
    }>): Promise<CoreAgentRuntime | null>;
  }>;
  readonly admission: Readonly<{
    reserve(input: Readonly<{
      principal: CorePrincipal;
      operation: CoreAdmissionOperation;
      operationId: string;
      estimatedUnits: number;
    }>): Promise<CoreAdmission>;
    settle(input: Readonly<{ reservationId: string; actualUnits: number }>): Promise<void>;
    cancel(input: Readonly<{ reservationId: string }>): Promise<void>;
  }>;
  readonly internal: Readonly<{
    authorize(request: FastifyRequest, scope: string): Promise<void>;
  }>;
}

const LOCAL_CONTEXT: CorePrincipal = Object.freeze({
  actorId: LOCAL_ACTOR_ID,
  actorLabel: "Local operator",
  workspace: Object.freeze({
    id: LOCAL_WORKSPACE_ID,
    name: "Local workspace",
    createdAt: "1970-01-01T00:00:00.000Z",
  }),
  capabilities: CORE_CAPABILITIES,
});

export function localAccessContext(): CorePrincipal {
  return LOCAL_CONTEXT;
}

export function createLocalHostServices(internalToken = ""): CoreHostServices {
  return Object.freeze({
    mode: "self-hosted" as const,
    access: Object.freeze({ resolvePrincipal: async () => LOCAL_CONTEXT }),
    agent: Object.freeze({ resolveRuntime: async () => null }),
    admission: Object.freeze({
      reserve: async () => Object.freeze({ reservationId: null }),
      settle: async () => undefined,
      cancel: async () => undefined,
    }),
    internal: Object.freeze({
      authorize: async (request: FastifyRequest) => {
        if (!internalToken || !bearerMatches(request.headers.authorization, internalToken)) {
          throw accessError(401, "HOST_SERVICE_UNAUTHORIZED", "Host service authorization failed");
        }
      },
    }),
  });
}

export function requireCoreCapability(principal: CorePrincipal, capability: CoreCapability): void {
  if (!principal.capabilities.includes(capability)) {
    throw accessError(403, "CAPABILITY_REQUIRED", "The requested operation is not permitted");
  }
}

export function accessError(
  statusCode: number,
  code: string,
  message: string,
): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
