import { json } from "@/lib/control-plane/http";

export async function POST() {
  return json({
    error: {
      code: "GITHUB_APP_INSTALLATION_BROKER_REQUIRED",
      message: "GitHub authorization requires the production installation-state broker and callback verifier.",
      details: {
        mode: "github-app-installation",
        requestedPermissions: ["contents:write", "pull_requests:write", "metadata:read"],
        passwordAccepted: false,
      },
    },
  }, { status: 503 });
}
