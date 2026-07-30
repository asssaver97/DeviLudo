import { jobCapabilities, routeJob, type JobKind } from "@/lib/runtime/job-routing";
import type { ServerOperatingSystem } from "@/lib/runtime/server-pools";

export const WORKFLOW_STATES = [
  "DRAFT",
  "AGENT_RUNNING",
  "ARTIFACT_BUILDING",
  "E2E_TESTING",
  "SIGNING",
  "STEAM_PUBLISHING",
  "CLEAN_INSTALL_VERIFYING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type WorkflowState = typeof WORKFLOW_STATES[number];

export type WorkflowSnapshot = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  state: WorkflowState;
  profile: "VALIDATE" | "RELEASE";
  targetPlatforms: readonly ServerOperatingSystem[];
  completedE2e: readonly ServerOperatingSystem[];
  completedSigning: readonly ServerOperatingSystem[];
  completedCleanInstall: readonly ServerOperatingSystem[];
}>;

export type WorkflowEvent =
  | Readonly<{ kind: "SPEC_APPROVED" }>
  | Readonly<{ kind: "CANCEL_REQUESTED" }>
  | Readonly<{ kind: "JOB_SUCCEEDED"; jobKind: JobKind; targetOperatingSystem: ServerOperatingSystem | null }>
  | Readonly<{ kind: "JOB_FAILED"; jobKind: JobKind; reason: string }>;

export type EnqueueCommand = Readonly<{
  jobKind: JobKind;
  targetOperatingSystem: ServerOperatingSystem | null;
  poolKind: ReturnType<typeof routeJob>;
  requiredCapabilities: readonly string[];
  exclusive: boolean;
  idempotencyKey: string;
}>;

export type WorkflowTransition = Readonly<{
  snapshot: WorkflowSnapshot;
  enqueue: readonly EnqueueCommand[];
}>;

export function initialWorkflowSnapshot(
  id: string,
  workspaceId: string,
  projectId: string,
  profile: "VALIDATE" | "RELEASE" = "VALIDATE",
  targetPlatforms: readonly ServerOperatingSystem[] = ["macos"],
): WorkflowSnapshot {
  if (targetPlatforms.length < 1 || targetPlatforms.length > 3 || new Set(targetPlatforms).size !== targetPlatforms.length) {
    throw new Error("Workflow target platforms are invalid");
  }
  return Object.freeze({
    id,
    workspaceId,
    projectId,
    state: "DRAFT",
    profile,
    targetPlatforms: Object.freeze([...targetPlatforms]),
    completedE2e: Object.freeze([]),
    completedSigning: Object.freeze([]),
    completedCleanInstall: Object.freeze([]),
  });
}

export function transitionWorkflow(snapshot: WorkflowSnapshot, event: WorkflowEvent): WorkflowTransition {
  if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(snapshot.state)) {
    return Object.freeze({ snapshot, enqueue: Object.freeze([]) });
  }
  if (event.kind === "CANCEL_REQUESTED") return result({ ...snapshot, state: "CANCELLED" }, []);
  if (event.kind === "JOB_FAILED") return result({ ...snapshot, state: "FAILED" }, []);
  if (event.kind === "SPEC_APPROVED" && snapshot.state === "DRAFT") {
    return result({ ...snapshot, state: "AGENT_RUNNING" }, [command(snapshot, "AGENT_GENERATION", null, "agent")]);
  }
  if (event.kind !== "JOB_SUCCEEDED") throw new Error(`Event ${event.kind} is invalid for ${snapshot.state}`);

  if (snapshot.state === "AGENT_RUNNING" && event.jobKind === "AGENT_GENERATION") {
    return result({ ...snapshot, state: "ARTIFACT_BUILDING" }, [command(snapshot, "ARTIFACT_BUILD", null, "artifact")]);
  }
  if (snapshot.state === "ARTIFACT_BUILDING" && event.jobKind === "ARTIFACT_BUILD") {
    return result(
      { ...snapshot, state: "E2E_TESTING" },
      snapshot.targetPlatforms.map(platform => command(snapshot, "E2E_TEST", platform, `e2e:${platform}`)),
    );
  }
  if (snapshot.state === "E2E_TESTING" && event.jobKind === "E2E_TEST" && event.targetOperatingSystem) {
    const completedE2e = appendPlatform(snapshot.completedE2e, event.targetOperatingSystem);
    if (completedE2e.length < snapshot.targetPlatforms.length) return result({ ...snapshot, completedE2e }, []);
    if (snapshot.profile === "VALIDATE") return result({ ...snapshot, state: "SUCCEEDED", completedE2e }, []);
    return result(
      { ...snapshot, state: "SIGNING", completedE2e },
      snapshot.targetPlatforms.map(platform => command(snapshot, "ARTIFACT_SIGN", platform, `sign:${platform}`)),
    );
  }
  if (snapshot.state === "SIGNING" && event.jobKind === "ARTIFACT_SIGN" && event.targetOperatingSystem) {
    const completedSigning = appendPlatform(snapshot.completedSigning, event.targetOperatingSystem);
    if (completedSigning.length < snapshot.targetPlatforms.length) return result({ ...snapshot, completedSigning }, []);
    return result(
      { ...snapshot, state: "STEAM_PUBLISHING", completedSigning },
      [command(snapshot, "STEAM_PUBLISH", null, "publish")],
    );
  }
  if (snapshot.state === "STEAM_PUBLISHING" && event.jobKind === "STEAM_PUBLISH") {
    return result(
      { ...snapshot, state: "CLEAN_INSTALL_VERIFYING" },
      snapshot.targetPlatforms.map(platform => command(snapshot, "STEAM_CLEAN_INSTALL", platform, `clean-install:${platform}`)),
    );
  }
  if (snapshot.state === "CLEAN_INSTALL_VERIFYING"
    && event.jobKind === "STEAM_CLEAN_INSTALL"
    && event.targetOperatingSystem) {
    const completedCleanInstall = appendPlatform(snapshot.completedCleanInstall, event.targetOperatingSystem);
    return result({
      ...snapshot,
      state: completedCleanInstall.length === snapshot.targetPlatforms.length ? "SUCCEEDED" : snapshot.state,
      completedCleanInstall,
    }, []);
  }
  throw new Error(`Job ${event.jobKind} is invalid for ${snapshot.state}`);
}

function command(
  snapshot: WorkflowSnapshot,
  jobKind: JobKind,
  targetOperatingSystem: ServerOperatingSystem | null,
  stage: string,
): EnqueueCommand {
  const poolKind = routeJob(jobKind, targetOperatingSystem ?? undefined);
  return Object.freeze({
    jobKind,
    targetOperatingSystem,
    poolKind,
    requiredCapabilities: jobCapabilities(jobKind),
    exclusive: poolKind.startsWith("E2E_"),
    idempotencyKey: `${snapshot.id}:${stage}`,
  });
}

function appendPlatform(
  values: readonly ServerOperatingSystem[],
  value: ServerOperatingSystem,
): readonly ServerOperatingSystem[] {
  return Object.freeze([...new Set([...values, value])].sort());
}

function result(snapshot: WorkflowSnapshot, enqueue: readonly EnqueueCommand[]): WorkflowTransition {
  return Object.freeze({
    snapshot: Object.freeze(snapshot),
    enqueue: Object.freeze(enqueue),
  });
}
