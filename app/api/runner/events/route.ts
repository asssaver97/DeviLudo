import { acceptDemoRunnerEvent, getRunnerDemoState } from "@/lib/control-plane/runner-demo";
import { bodyObject, HttpProblem, json, problemResponse } from "@/lib/control-plane/http";
import type { RunnerEvent, RunnerEventType } from "@/lib/domain/e2e";
import type { TargetPlatform } from "@/lib/domain/types";

const EVENT_TYPES = new Set<RunnerEventType>(["STARTED", "HEARTBEAT", "LOG", "SCREENSHOT", "VIDEO", "JUNIT", "PLATFORM_COMPLETED", "ATTEMPT_COMPLETED"]);
const PLATFORMS = new Set<TargetPlatform>(["windows", "linux", "macos"]);

export async function GET() {
  const state = getRunnerDemoState();
  return json({ data: { lease: state.lease, cursor: state.cursor }, meta: { demo: true, credentials: "mTLS in production" } });
}

export async function POST(request: Request) {
  try {
    const body = await bodyObject(request);
    const type = body.type;
    const platform = body.platform;
    if (typeof type !== "string" || !EVENT_TYPES.has(type as RunnerEventType)) throw new HttpProblem(400, "INVALID_EVENT_TYPE", "Unknown runner event type");
    if (typeof platform !== "string" || !PLATFORMS.has(platform as TargetPlatform)) throw new HttpProblem(400, "INVALID_PLATFORM", "Unknown target platform");
    const event: RunnerEvent = {
      attemptId: stringField(body, "attemptId"),
      runnerId: stringField(body, "runnerId"),
      fencingToken: integerField(body, "fencingToken"),
      seqNo: integerField(body, "seqNo"),
      commitSha: stringField(body, "commitSha"),
      sourceDigest: stringField(body, "sourceDigest"),
      platform: platform as TargetPlatform,
      type: type as RunnerEventType,
      status: body.status === "PASSED" || body.status === "FAILED" ? body.status : "RUNNING",
      artifactDigest: typeof body.artifactDigest === "string" ? body.artifactDigest : null,
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : new Date().toISOString(),
    };
    const decision = acceptDemoRunnerEvent(event, new Date().toISOString());
    return json({ data: decision }, { status: decision.accepted ? 202 : 409 });
  } catch (error) {
    return problemResponse(error);
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value) throw new HttpProblem(400, "INVALID_FIELD", `${field} must be a non-empty string`);
  return value;
}

function integerField(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (!Number.isInteger(value) || (value as number) < 0) throw new HttpProblem(400, "INVALID_FIELD", `${field} must be a non-negative integer`);
  return value as number;
}
