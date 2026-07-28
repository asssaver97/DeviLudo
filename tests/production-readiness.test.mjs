import assert from "node:assert/strict";
import test from "node:test";

import { evaluateProductionWebReadiness } from "../lib/health/production-readiness.ts";
import { evaluateProductionP0OperationalReadiness } from "../lib/health/production-p0-readiness.ts";

const SESSION_KEY = Buffer.alloc(32, 7).toString("base64url");
const ADMIN_KEY = Buffer.alloc(32, 9).toString("base64");

const HEALTH_BY_HOST = Object.freeze({
  "identity.internal": { status: "ok", service: "deviludo-identity-broker" },
  "identity-admin.internal": { status: "ok", service: "deviludo-identity-broker" },
  "github-auth.internal": { status: "ok", service: "deviludo-github-authorization-broker" },
  "project-repository.internal": { status: "ok", service: "deviludo-project-repository-broker" },
  "spec-dialogue.internal": { status: "ok", service: "deviludo-spec-dialogue" },
  "user-acceptance.internal": { status: "ok", service: "deviludo-user-acceptance" },
  "delivery-projection.internal": { status: "ok", service: "deviludo-delivery-projection" },
  "admin-control-plane.internal": { status: "ok", service: "deviludo-admin-control-plane" },
  "steam-enrollment.internal": { schemaVersion: "deviludo.steam-access-health.v1", status: "ok" },
  "release-authorization.internal": { schemaVersion: "deviludo.steam-access-health.v1", status: "ok" },
  "p0-runtime.internal": {
    schemaVersion: "deviludo.p0-runtime-readiness.v1", status: "ready",
    claudeAgent: "claude-code", claudeCliVersion: "2.1.201", claudeModel: "claude-opus-4-1-20250805", claudeProfile: "READY",
    agentFleet: "READY", linuxFleet: "READY", windowsFleet: "READY", macCapacity: "ON_DEMAND_READY",
    inferenceGateway: "READY", artifactStore: "READY", vault: "READY", migrations: "READY",
  },
});

function configuredEnvironment() {
  return {
    DEVILUDO_IDENTITY_BROKER_URL: "https://identity.internal/",
    DEVILUDO_IDENTITY_ADMIN_BROKER_URL: "https://identity-admin.internal/",
    DEVILUDO_GITHUB_AUTH_BROKER_URL: "https://github-auth.internal/",
    DEVILUDO_PROJECT_REPOSITORY_BROKER_URL: "https://project-repository.internal/",
    DEVILUDO_SPEC_DIALOGUE_BROKER_URL: "https://spec-dialogue.internal/",
    DEVILUDO_USER_ACCEPTANCE_BROKER_URL: "https://user-acceptance.internal/",
    DEVILUDO_DELIVERY_PROJECTION_BROKER_URL: "https://delivery-projection.internal/",
    DEVILUDO_ADMIN_CONTROL_PLANE_BROKER_URL: "https://admin-control-plane.internal/",
    DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY: ADMIN_KEY,
    DEVILUDO_STEAM_ENROLLMENT_BROKER_URL: "https://steam-enrollment.internal/",
    DEVILUDO_STEAM_ENROLLMENT_PUBLIC_ORIGIN: "https://steam-login.example/",
    DEVILUDO_RELEASE_AUTHORIZATION_BROKER_URL: "https://release-authorization.internal/",
    DEVILUDO_RELEASE_AUTHORIZATION_PUBLIC_ORIGIN: "https://release-approval.example/",
    DEVILUDO_SESSION_HMAC_KEY: SESSION_KEY,
  };
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });
}

function healthyFetch(calls = []) {
  return async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const body = HEALTH_BY_HOST[url.hostname];
    assert.ok(body, `Unexpected health host ${url.hostname}`);
    return json(body);
  };
}

test("production Web readiness requires the complete live idea-to-Steam broker set", async () => {
  const missing = await evaluateProductionWebReadiness({}, { fetch: healthyFetch() });
  assert.equal(missing.ready, false);
  assert.deepEqual(new Set(Object.values(missing.dependencies)), new Set(["NOT_CONFIGURED"]));

  const calls = [];
  const ready = await evaluateProductionWebReadiness(configuredEnvironment(), { fetch: healthyFetch(calls) });
  assert.equal(ready.ready, true);
  assert.deepEqual(new Set(Object.values(ready.dependencies)), new Set(["READY"]));
  assert.equal(calls.length, 10, "the shared Steam enrollment/configuration origin is probed once");
  assert.equal(calls.every(({ url }) => url.pathname === "/healthz" && url.protocol === "https:"), true);
  assert.equal(calls.every(({ init }) => init.method === "GET" && init.redirect === "error" && init.signal instanceof AbortSignal), true);
});

test("P0 internal readiness excludes GitHub and Steam without silently declaring the public product ready", async () => {
  const environment = configuredEnvironment();
  delete environment.DEVILUDO_GITHUB_AUTH_BROKER_URL;
  delete environment.DEVILUDO_PROJECT_REPOSITORY_BROKER_URL;
  delete environment.DEVILUDO_STEAM_ENROLLMENT_BROKER_URL;
  delete environment.DEVILUDO_STEAM_ENROLLMENT_PUBLIC_ORIGIN;
  delete environment.DEVILUDO_RELEASE_AUTHORIZATION_BROKER_URL;
  delete environment.DEVILUDO_RELEASE_AUTHORIZATION_PUBLIC_ORIGIN;
  const calls = [];
  const readiness = await evaluateProductionWebReadiness(environment, { profile: "P0_INTERNAL", fetch: healthyFetch(calls) });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.dependencies.githubAuthorizationBroker, "NOT_REQUIRED");
  assert.equal(readiness.dependencies.projectRepositoryBroker, "NOT_REQUIRED");
  assert.equal(readiness.dependencies.steamEnrollmentBroker, "NOT_REQUIRED");
  assert.equal(readiness.dependencies.releaseAuthorizationBroker, "NOT_REQUIRED");
  assert.equal(calls.length, 6);
});

test("P0 operational readiness additionally requires a pinned Claude and complete runtime fleet", async () => {
  const environment = { ...configuredEnvironment(), DEVILUDO_P0_RUNTIME_READINESS_URL: "https://p0-runtime.internal/" };
  const ready = await evaluateProductionP0OperationalReadiness(environment, { fetch: healthyFetch() });
  assert.equal(ready.ready, true);
  assert.equal(ready.p0Runtime, "READY");
  const missing = await evaluateProductionP0OperationalReadiness(configuredEnvironment(), { fetch: healthyFetch() });
  assert.equal(missing.ready, false);
  assert.equal(missing.p0Runtime, "NOT_CONFIGURED");
  const floating = await evaluateProductionP0OperationalReadiness(environment, { fetch: async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "p0-runtime.internal") return json({ ...HEALTH_BY_HOST[url.hostname], claudeModel: "sonnet" });
    return healthyFetch()(input, init);
  } });
  assert.equal(floating.ready, false);
  assert.equal(floating.p0Runtime, "IDENTITY_MISMATCH");
});

test("production Web readiness rejects partial secrets and unsafe broker origins without exposing them", async () => {
  const partial = await evaluateProductionWebReadiness({
    ...configuredEnvironment(),
    DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY: undefined,
    DEVILUDO_STEAM_ENROLLMENT_BROKER_URL: "http://127.0.0.1:4550/",
    DEVILUDO_RELEASE_AUTHORIZATION_PUBLIC_ORIGIN: "https://operator:secret@release-approval.example/",
  }, { fetch: healthyFetch() });
  assert.equal(partial.ready, false);
  assert.equal(partial.dependencies.adminControlPlaneBroker, "INVALID_CONFIGURATION");
  assert.equal(partial.dependencies.steamEnrollmentBroker, "INVALID_CONFIGURATION");
  assert.equal(partial.dependencies.steamProjectConfigurationBroker, "INVALID_CONFIGURATION");
  assert.equal(partial.dependencies.releaseAuthorizationBroker, "INVALID_CONFIGURATION");
  assert.doesNotMatch(JSON.stringify(partial), /secret|127\.0\.0\.1|operator/);
});

test("production Web readiness fails closed for outage, wrong service identity, and oversized evidence", async () => {
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.hostname === "project-repository.internal") throw new Error("private upstream failure");
    if (url.hostname === "github-auth.internal") {
      return json({ status: "ok", service: "attacker-controlled-service" });
    }
    if (url.hostname === "delivery-projection.internal") {
      return json(HEALTH_BY_HOST[url.hostname], { headers: { "content-length": "20000" } });
    }
    return json(HEALTH_BY_HOST[url.hostname]);
  };
  const readiness = await evaluateProductionWebReadiness(configuredEnvironment(), { fetch: fetcher });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.dependencies.projectRepositoryBroker, "UNAVAILABLE");
  assert.equal(readiness.dependencies.githubAuthorizationBroker, "IDENTITY_MISMATCH");
  assert.equal(readiness.dependencies.deliveryProjectionBroker, "IDENTITY_MISMATCH");
  assert.doesNotMatch(JSON.stringify(readiness), /private upstream|attacker-controlled/);
});

test("production Web readiness requires exact JSON identities and validates timeout bounds", async () => {
  const fetcher = async (input) => {
    const url = new URL(input);
    if (url.hostname === "identity.internal") {
      return json({ ...HEALTH_BY_HOST[url.hostname], unexpected: "field" });
    }
    if (url.hostname === "spec-dialogue.internal") {
      return new Response(JSON.stringify(HEALTH_BY_HOST[url.hostname]), { headers: { "content-type": "text/plain" } });
    }
    return json(HEALTH_BY_HOST[url.hostname]);
  };
  const readiness = await evaluateProductionWebReadiness(configuredEnvironment(), { fetch: fetcher });
  assert.equal(readiness.dependencies.identityBroker, "IDENTITY_MISMATCH");
  assert.equal(readiness.dependencies.specificationDialogueBroker, "IDENTITY_MISMATCH");
  await assert.rejects(
    evaluateProductionWebReadiness(configuredEnvironment(), { fetch: fetcher, timeoutMs: 99 }),
    /timeout is invalid/,
  );
});
