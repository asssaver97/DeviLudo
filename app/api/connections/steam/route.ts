import { json } from "@/lib/control-plane/http";

export async function POST() {
  return json({
    data: {
      sessionId: `steam-bootstrap-${Date.now()}`,
      state: "AWAITING_STEAM_GUARD",
      expiresInSeconds: 300,
      storesAfterCompletion: "encrypted-config-vdf-session",
      storesPrimaryPassword: false,
    },
  }, { status: 201 });
}
