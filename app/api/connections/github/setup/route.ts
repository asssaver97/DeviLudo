import { json } from "@/lib/control-plane/http";

/** Untrusted setup parameters are handled only by the authenticated broker. */
export async function GET() {
  return json({
    error: {
      code: "GITHUB_APP_INSTALLATION_BROKER_REQUIRED",
      message: "GitHub App setup callbacks require the production authorization broker.",
    },
  }, { status: 503 });
}
