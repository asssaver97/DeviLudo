import { adminControlPlaneBrokerFromEnvironment } from "@/lib/admin/control-plane-broker";
import { identityAdminBrokerFromEnvironment, identityBrokerFromEnvironment } from "@/lib/auth/identity-broker";
import { githubBrokerRuntimeFromEnvironment } from "@/lib/connections/github-broker";
import { steamEnrollmentRuntimeFromEnvironment } from "@/lib/connections/steam-broker";
import { deliveryProjectionBrokerFromEnvironment } from "@/lib/delivery-projection/broker";
import { projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";
import { releaseAuthorizationRuntimeFromEnvironment } from "@/lib/releases/publish-broker";
import { specDialogueBrokerRuntimeFromEnvironment } from "@/lib/spec-dialogue/broker";
import { userAcceptanceBrokerFromEnvironment } from "@/lib/user-acceptance/broker";

const MAX_HEALTH_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

export type ProductionDependencyStatus =
  | "READY"
  | "NOT_CONFIGURED"
  | "INVALID_CONFIGURATION"
  | "UNAVAILABLE"
  | "IDENTITY_MISMATCH";

export interface ProductionDependencyStatuses {
  readonly identityBroker: ProductionDependencyStatus;
  readonly identityAdminBroker: ProductionDependencyStatus;
  readonly githubAuthorizationBroker: ProductionDependencyStatus;
  readonly projectRepositoryBroker: ProductionDependencyStatus;
  readonly specificationDialogueBroker: ProductionDependencyStatus;
  readonly userAcceptanceBroker: ProductionDependencyStatus;
  readonly deliveryProjectionBroker: ProductionDependencyStatus;
  readonly adminControlPlaneBroker: ProductionDependencyStatus;
  readonly steamEnrollmentBroker: ProductionDependencyStatus;
  readonly steamProjectConfigurationBroker: ProductionDependencyStatus;
  readonly releaseAuthorizationBroker: ProductionDependencyStatus;
}

export interface ProductionWebReadiness {
  readonly ready: boolean;
  readonly dependencies: Readonly<ProductionDependencyStatuses>;
}

type Environment = Readonly<Record<string, string | undefined>>;
type FetchLike = typeof fetch;
type ExpectedHealth = Readonly<Record<string, string>>;
type ProbeCache = Map<string, Promise<ProductionDependencyStatus>>;

export interface ProductionReadinessOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

const IDENTITY_HEALTH = Object.freeze({ status: "ok", service: "deviludo-identity-broker" });
const GITHUB_HEALTH = Object.freeze({ status: "ok", service: "deviludo-github-authorization-broker" });
const PROJECT_REPOSITORY_HEALTH = Object.freeze({ status: "ok", service: "deviludo-project-repository-broker" });
const SPEC_DIALOGUE_HEALTH = Object.freeze({ status: "ok", service: "deviludo-spec-dialogue" });
const USER_ACCEPTANCE_HEALTH = Object.freeze({ status: "ok", service: "deviludo-user-acceptance" });
const DELIVERY_PROJECTION_HEALTH = Object.freeze({ status: "ok", service: "deviludo-delivery-projection" });
const ADMIN_CONTROL_PLANE_HEALTH = Object.freeze({ status: "ok", service: "deviludo-admin-control-plane" });
const STEAM_ACCESS_HEALTH = Object.freeze({ schemaVersion: "deviludo.steam-access-health.v1", status: "ok" });

/**
 * Production readiness is intentionally an online check. Constructing a broker
 * client proves only that configuration parses; every configured dependency must
 * also answer its authenticated /healthz route with its exact service identity.
 */
export async function evaluateProductionWebReadiness(
  env: Environment = process.env,
  options: ProductionReadinessOptions = {},
): Promise<ProductionWebReadiness> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error("Production readiness timeout is invalid");
  }
  const fetcher = options.fetch ?? fetch;
  const probes: ProbeCache = new Map();
  const [
    identityBroker,
    identityAdminBroker,
    githubAuthorizationBroker,
    projectRepositoryBroker,
    specificationDialogueBroker,
    userAcceptanceBroker,
    deliveryProjectionBroker,
    adminControlPlaneBroker,
    steamEnrollmentBroker,
    steamProjectConfigurationBroker,
    releaseAuthorizationBroker,
  ] = await Promise.all([
    dependencyStatus(() => identityBrokerFromEnvironment(env), env.DEVILUDO_IDENTITY_BROKER_URL, IDENTITY_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => identityAdminBrokerFromEnvironment(env), env.DEVILUDO_IDENTITY_ADMIN_BROKER_URL, IDENTITY_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => githubBrokerRuntimeFromEnvironment(env), env.DEVILUDO_GITHUB_AUTH_BROKER_URL, GITHUB_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => projectRepositoryBrokerFromEnvironment(env), env.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL, PROJECT_REPOSITORY_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => specDialogueBrokerRuntimeFromEnvironment(env), env.DEVILUDO_SPEC_DIALOGUE_BROKER_URL, SPEC_DIALOGUE_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => userAcceptanceBrokerFromEnvironment(env), env.DEVILUDO_USER_ACCEPTANCE_BROKER_URL, USER_ACCEPTANCE_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => deliveryProjectionBrokerFromEnvironment(env), env.DEVILUDO_DELIVERY_PROJECTION_BROKER_URL, DELIVERY_PROJECTION_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => adminControlPlaneBrokerFromEnvironment(env), env.DEVILUDO_ADMIN_CONTROL_PLANE_BROKER_URL, ADMIN_CONTROL_PLANE_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => steamEnrollmentRuntimeFromEnvironment(env), env.DEVILUDO_STEAM_ENROLLMENT_BROKER_URL, STEAM_ACCESS_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => steamEnrollmentRuntimeFromEnvironment(env), env.DEVILUDO_STEAM_ENROLLMENT_BROKER_URL, STEAM_ACCESS_HEALTH, fetcher, timeoutMs, probes),
    dependencyStatus(() => releaseAuthorizationRuntimeFromEnvironment(env), env.DEVILUDO_RELEASE_AUTHORIZATION_BROKER_URL, STEAM_ACCESS_HEALTH, fetcher, timeoutMs, probes),
  ]);
  const dependencies = Object.freeze({
    identityBroker,
    identityAdminBroker,
    githubAuthorizationBroker,
    projectRepositoryBroker,
    specificationDialogueBroker,
    userAcceptanceBroker,
    deliveryProjectionBroker,
    adminControlPlaneBroker,
    steamEnrollmentBroker,
    steamProjectConfigurationBroker,
    releaseAuthorizationBroker,
  });
  return Object.freeze({
    ready: Object.values(dependencies).every((status) => status === "READY"),
    dependencies,
  });
}

async function dependencyStatus(
  factory: () => object | null,
  endpoint: string | undefined,
  expected: ExpectedHealth,
  fetcher: FetchLike,
  timeoutMs: number,
  probes: ProbeCache,
): Promise<ProductionDependencyStatus> {
  try {
    if (!factory()) return "NOT_CONFIGURED";
  } catch {
    return "INVALID_CONFIGURATION";
  }
  if (!endpoint) return "INVALID_CONFIGURATION";
  let healthUrl: URL;
  try { healthUrl = new URL("/healthz", endpoint.trim()); }
  catch { return "INVALID_CONFIGURATION"; }
  const key = `${healthUrl.href}\n${JSON.stringify(expected)}`;
  const existing = probes.get(key);
  if (existing) return existing;
  const probe = probeHealth(healthUrl, expected, fetcher, timeoutMs);
  probes.set(key, probe);
  return probe;
}

async function probeHealth(
  url: URL,
  expected: ExpectedHealth,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<ProductionDependencyStatus> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "UNAVAILABLE";
  }
  if (!response.ok) return "UNAVAILABLE";
  try {
    if (response.redirected) throw new Error("Redirected health response");
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new Error("Health response is not JSON");
    }
    const body = await readBoundedJsonObject(response);
    const actualKeys = Object.keys(body).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error("Health response fields do not match");
    }
    if (expectedKeys.some((key) => body[key] !== expected[key])) throw new Error("Health service identity does not match");
    return "READY";
  } catch {
    return "IDENTITY_MISMATCH";
  }
}

async function readBoundedJsonObject(response: Response): Promise<Record<string, unknown>> {
  const declaredValue = response.headers.get("content-length");
  if (declaredValue) {
    const declared = Number(declaredValue);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_HEALTH_RESPONSE_BYTES) {
      throw new Error("Health response length is invalid");
    }
  }
  if (!response.body) throw new Error("Health response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_HEALTH_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Health response exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Health response is not an object");
  return value as Record<string, unknown>;
}
