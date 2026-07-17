import { json } from "@/lib/control-plane/http";

export async function POST() {
  return json({
    data: {
      mode: "github-app-oauth",
      state: "DEMO",
      authorizeUrl: "/settings/connections?github=demo-authorized",
      requestedPermissions: ["contents:write", "pull_requests:write", "checks:read"],
      passwordAccepted: false,
    },
  }, { status: 201 });
}
