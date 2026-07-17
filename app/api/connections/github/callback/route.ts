import { json } from "@/lib/control-plane/http";

/** OAuth codes and state are intentionally not parsed or reflected here. */
export async function GET() {
  return json({
    error: {
      code: "GITHUB_APP_INSTALLATION_BROKER_REQUIRED",
      message: "GitHub user authorization callbacks require the production authorization broker.",
    },
  }, { status: 503 });
}
