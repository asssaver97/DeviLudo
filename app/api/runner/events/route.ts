import { getRunnerDemoState } from "@/lib/control-plane/runner-demo";
import { json } from "@/lib/control-plane/http";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

export async function GET(request: Request) {
  if (!isLoopbackTestRequest(request)) {
    return json({
      error: {
        code: "RUNNER_FLEET_PROJECTION_REQUIRED",
        message: "生产 Runner 状态只能通过项目级只读投影读取。",
      },
    }, { status: 503 });
  }
  const state = getRunnerDemoState();
  return json({
    data: { lease: state.lease, cursor: state.cursor },
    meta: {
      demo: true,
      readOnly: true,
      runnerIngress: "DEDICATED_MTLS_SERVICE_REQUIRED",
    },
  });
}

export async function POST() {
  return json({
    error: {
      code: "RUNNER_MTLS_INGRESS_REQUIRED",
      message: "Runner events are accepted only by the dedicated mutual-TLS ingress service.",
    },
  }, { status: 503 });
}
