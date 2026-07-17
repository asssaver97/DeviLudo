import { json } from "@/lib/control-plane/http";

export async function POST() {
  return json({
    error: {
      code: "STEAM_GUARD_ENROLLMENT_BROKER_REQUIRED",
      message: "Steam Guard enrollment requires the isolated production enrollment broker.",
      details: {
        acceptedCredential: "encrypted-config-vdf-session-only",
        storesPrimaryPassword: false,
      },
    },
  }, { status: 503 });
}
