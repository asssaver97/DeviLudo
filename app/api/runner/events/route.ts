import { getRunnerDemoState } from "@/lib/control-plane/runner-demo";
import { json } from "@/lib/control-plane/http";

export async function GET() {
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
