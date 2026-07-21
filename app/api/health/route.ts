import { json } from "@/lib/control-plane/http";
import { evaluateProductionWebReadiness } from "@/lib/health/production-readiness";
import { readLocalDelivery } from "@/lib/local-delivery/store";
import { isLoopbackTestRequest } from "@/lib/security/local-test-mode";

const localRuntimeUrl = loopbackRuntimeUrl();
const localAgentRuntimeUrl = loopbackOrigin("DEVILUDO_LOCAL_AGENT_RUNTIME_URL", "http://127.0.0.1:4312");

type LocalAgentState = "READY" | "VERSION_MISMATCH" | "UNAVAILABLE";
type LocalAgentHealth = {
  status: "ok" | "degraded" | "NOT_CONNECTED";
  service?: string;
  executionEnabled?: boolean;
  inferenceGateway?: "CONFIGURED" | "NOT_CONFIGURED";
  providerBindingProbe?: "CONFIGURED" | "NOT_CONFIGURED";
  workerImageIdentity?: string | null;
  expectedWorkerImageIdentity?: string | null;
  workerImageVerified?: boolean;
  workerIdentityMode?: "PINNED_ENV" | "LOCAL_DETERMINISTIC" | "NOT_CONFIGURED";
  agents?: { agent: "claude-code" | "codex-cli"; expectedVersion: string; observedVersion: string | null; state: LocalAgentState }[];
};

export async function GET(request: Request) {
  if (!isLoopbackTestRequest(request)) return await productionHealth();
  try {
    const delivery = await readLocalDelivery("ember-archipelago", "SPEC-008");
    let localRuntime: { status: string; godotVersion?: string | null } = { status: "NOT_CONNECTED" };
    let localAgentRuntime: LocalAgentHealth = { status: "NOT_CONNECTED" };
    try {
      const response = await fetch(`${localRuntimeUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) localRuntime = await response.json() as { status: string; godotVersion?: string | null };
    } catch { /* the local runtime is an optional, explicit process */ }
    try {
      const response = await fetch(`${localAgentRuntimeUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) localAgentRuntime = await response.json() as LocalAgentHealth;
    } catch { /* Agent discovery is optional and never enables execution by itself */ }
    return json({
      status: "ok",
      service: "deviludo-control-plane-preview",
      version: "0.1.0-beta",
      mode: "LOCALHOST_D1",
      delivery: { stage: delivery.stage, revision: delivery.revision, durable: true },
      dependencies: {
        d1: "READY",
        fixtureExecutor: localRuntime.status === "ok" ? "READY" : "NOT_CONNECTED",
        localGodot: localRuntime.godotVersion ?? null,
        developmentWorker: isVerifiedAgentRuntime(localAgentRuntime) ? "READY" : "BLOCKED",
        localAgentRuntime: localAgentRuntime.status === "NOT_CONNECTED" ? "NOT_CONNECTED" : "CONNECTED",
        localAgents: localAgentRuntime.agents ?? [],
        inferenceGateway: localAgentRuntime.inferenceGateway ?? "NOT_CONFIGURED",
        providerBindingProbe: localAgentRuntime.providerBindingProbe ?? "NOT_CONFIGURED",
        workerImageIdentity: localAgentRuntime.workerImageIdentity ?? null,
        expectedWorkerImageIdentity: localAgentRuntime.expectedWorkerImageIdentity ?? null,
        workerImageVerified: localAgentRuntime.workerImageVerified === true,
        workerIdentityMode: localAgentRuntime.workerIdentityMode ?? "NOT_CONFIGURED",
        windowsRunner: "NOT_CONNECTED",
        linuxRunner: "NOT_CONNECTED",
        macosRunner: "NOT_CONNECTED",
        steam: "GUARD_REQUIRED",
      },
      capabilities: ["spec-dialogue", "agent-governance", "local-delivery", "e2e-evidence", "steam-gates"],
      time: new Date().toISOString(),
    });
  } catch (error) {
    return json({
      status: "degraded",
      service: "deviludo-control-plane-preview",
      error: error instanceof Error ? error.message : "Local D1 is unavailable",
      time: new Date().toISOString(),
    }, { status: 503 });
  }
}

async function productionHealth(): Promise<Response> {
  try {
    const readiness = await evaluateProductionWebReadiness();
    return json({
      status: readiness.ready ? "ok" : "degraded",
      service: "deviludo-control-plane",
      version: "0.1.0-beta",
      mode: "PRODUCTION",
      ready: readiness.ready,
      dependencies: readiness.dependencies,
      capabilities: PRODUCTION_CAPABILITIES,
      time: new Date().toISOString(),
    }, { status: readiness.ready ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch {
    return json({
      status: "degraded",
      service: "deviludo-control-plane",
      version: "0.1.0-beta",
      mode: "PRODUCTION",
      ready: false,
      dependencies: unavailableProductionDependencies(),
      capabilities: PRODUCTION_CAPABILITIES,
      time: new Date().toISOString(),
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

const PRODUCTION_CAPABILITIES = Object.freeze([
  "invited-github-login", "revocable-platform-session", "spec-dialogue", "agent-governance",
  "delivery-projection", "github-app", "project-repository-onboarding", "user-acceptance",
  "steam-enrollment", "steam-project-configuration", "steam-release-authorization",
]);

function unavailableProductionDependencies() {
  return Object.freeze({
    identityBroker: "UNAVAILABLE",
    identityAdminBroker: "UNAVAILABLE",
    githubAuthorizationBroker: "UNAVAILABLE",
    projectRepositoryBroker: "UNAVAILABLE",
    specificationDialogueBroker: "UNAVAILABLE",
    userAcceptanceBroker: "UNAVAILABLE",
    deliveryProjectionBroker: "UNAVAILABLE",
    adminControlPlaneBroker: "UNAVAILABLE",
    steamEnrollmentBroker: "UNAVAILABLE",
    steamProjectConfigurationBroker: "UNAVAILABLE",
    releaseAuthorizationBroker: "UNAVAILABLE",
  });
}

function isVerifiedAgentRuntime(health: LocalAgentHealth): boolean {
  return health.service === "deviludo-local-agent-runtime"
    && health.status === "ok"
    && health.executionEnabled === true
    && health.inferenceGateway === "CONFIGURED"
    && health.providerBindingProbe === "CONFIGURED"
    && health.workerImageVerified === true
    && Boolean(health.agents?.some((agent) => agent.state === "READY"));
}

function loopbackRuntimeUrl() {
  return loopbackOrigin("DEVILUDO_LOCAL_RUNTIME_URL", "http://127.0.0.1:4311");
}

function loopbackOrigin(environmentName: string, fallback: string) {
  const url = new URL(process.env[environmentName] ?? fallback);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.username || url.password || url.search || url.hash) {
    throw new Error(`${environmentName} must be a plain loopback HTTP origin`);
  }
  return url.origin;
}
