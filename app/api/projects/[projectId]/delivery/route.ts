import { bodyObject, idempotencyKey, json, problemResponse, requireString } from "@/lib/control-plane/http";
import { commandLocalDelivery, readLocalDelivery } from "@/lib/local-delivery/store";
import type { LocalDeliveryAction } from "@/lib/local-delivery/model";

const actions = new Set<LocalDeliveryAction>([
  "advance",
  "provider-fail",
  "provider-resume",
  "accept",
  "confirm-mfa",
  "external-approve",
  "reset",
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    return json({ data: await readLocalDelivery(projectId), meta: { mode: "LOCAL_D1" } });
  } catch (error) {
    return problemResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const body = await bodyObject(request);
    const action = requireString(body, "action", 64) as LocalDeliveryAction;
    if (!actions.has(action)) {
      return json({ error: { code: "UNSUPPORTED_ACTION", message: "不支持的本地交付动作" } }, { status: 400 });
    }
    const result = await commandLocalDelivery(
      projectId,
      action,
      `delivery:${projectId}:${idempotencyKey(request)}`,
    );
    return json(
      { data: result.snapshot, meta: { mode: "LOCAL_D1", idempotentReplay: result.replayed } },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    return problemResponse(error);
  }
}
