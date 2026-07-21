import assert from "node:assert/strict";
import test from "node:test";

import { evaluateProductionWebReadiness } from "../lib/health/production-readiness.ts";

const SESSION_KEY = Buffer.alloc(32, 7).toString("base64url");
const ADMIN_KEY = Buffer.alloc(32, 9).toString("base64");

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

test("production Web readiness requires the complete idea-to-Steam broker set", () => {
  const missing = evaluateProductionWebReadiness({});
  assert.equal(missing.ready, false);
  assert.deepEqual(new Set(Object.values(missing.dependencies)), new Set(["NOT_CONFIGURED"]));

  const ready = evaluateProductionWebReadiness(configuredEnvironment());
  assert.equal(ready.ready, true);
  assert.deepEqual(new Set(Object.values(ready.dependencies)), new Set(["CONFIGURED"]));
});

test("production Web readiness rejects partial secrets and unsafe broker origins without exposing them", () => {
  const partial = evaluateProductionWebReadiness({
    ...configuredEnvironment(),
    DEVILUDO_ADMIN_CONTROL_PLANE_HMAC_KEY: undefined,
    DEVILUDO_STEAM_ENROLLMENT_BROKER_URL: "http://127.0.0.1:4550/",
    DEVILUDO_RELEASE_AUTHORIZATION_PUBLIC_ORIGIN: "https://operator:secret@release-approval.example/",
  });
  assert.equal(partial.ready, false);
  assert.equal(partial.dependencies.adminControlPlaneBroker, "INVALID_CONFIGURATION");
  assert.equal(partial.dependencies.steamEnrollmentBroker, "INVALID_CONFIGURATION");
  assert.equal(partial.dependencies.releaseAuthorizationBroker, "INVALID_CONFIGURATION");
  assert.doesNotMatch(JSON.stringify(partial), /secret|127\.0\.0\.1|operator/);
});
