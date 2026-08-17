import type { WorkspaceSummary } from "@/lib/product/contracts";

/**
 * DeviLudo is a self-hosted, single-operator application. These stable opaque
 * identifiers keep workflow ownership and RLS boundaries deterministic while
 * the application remains a single local instance.
 */
export const LOCAL_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";

export type LocalAccessContext = Readonly<{
  actorId: string;
  actorLabel: "Local operator";
  workspace: WorkspaceSummary;
}>;

const LOCAL_CONTEXT: LocalAccessContext = Object.freeze({
  actorId: LOCAL_ACTOR_ID,
  actorLabel: "Local operator",
  workspace: Object.freeze({
    id: LOCAL_WORKSPACE_ID,
    name: "Local workspace",
    createdAt: "1970-01-01T00:00:00.000Z",
  }),
});

export function localAccessContext(): LocalAccessContext {
  return LOCAL_CONTEXT;
}
