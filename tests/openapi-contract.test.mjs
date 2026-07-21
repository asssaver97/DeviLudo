import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contract = readFileSync(new URL("../openapi/deviludo.yaml", import.meta.url), "utf8");

const browserOperations = [
  ["/projects/repositories", "get"],
  ["/projects", "get"],
  ["/projects", "post"],
  ["/projects/{projectId}", "get"],
  ["/projects/{projectId}/agent-settings", "get"],
  ["/projects/{projectId}/agent-settings", "put"],
  ["/projects/{projectId}/steam-settings", "get"],
  ["/projects/{projectId}/steam-settings", "post"],
  ["/projects/{projectId}/runners", "get"],
  ["/projects/{projectId}/evidence", "get"],
  ["/projects/{projectId}/delivery", "get"],
  ["/projects/{projectId}/delivery", "post"],
  ["/projects/{projectId}/conversation", "get"],
  ["/projects/{projectId}/conversation", "post"],
  ["/projects/{projectId}/spec-revisions", "get"],
  ["/projects/{projectId}/spec-revisions", "post"],
  ["/projects/{projectId}/feedback", "post"],
  ["/projects/{projectId}/acceptance", "post"],
  ["/settings/agents", "get"],
  ["/settings/agents/credentials", "post"],
  ["/settings/agents/credentials/{id}/rotate", "post"],
  ["/settings/agents/credentials/{id}/revoke", "post"],
  ["/settings/agents/profiles", "post"],
  ["/settings/agents/profiles/{id}/validate", "post"],
  ["/settings/agents/default", "put"],
];

test("production browser surface is documented with trusted cookie authentication", () => {
  for (const [path, method] of browserOperations) {
    const operation = operationBlock(path, method);
    assert.match(operation, /^      security: \[\{ cookieAuth: \[\] \}\]$/m, `${method.toUpperCase()} ${path}`);
  }
  assert.match(operationBlock("/health", "get"), /^      security: \[\]$/m);
});

test("session contract separates invited GitHub logout from the trusted administrator shell projection", () => {
  const readSession = operationBlock("/auth/session", "get");
  assert.match(readSession, /security: \[\{ cookieAuth: \[\] \}, \{ trustedAdminAssertion: \[\] \}\]/);
  assert.match(readSession, /PlatformSessionProjection/);
  assert.match(operationBlock("/auth/session", "delete"), /security: \[\{ cookieAuth: \[\] \}\]/);
  const projection = schemaBlock("PlatformSessionProjection");
  for (const field of ["authMode", "canSignOut", "capabilities", "platform-agents:manage", "tenant-agents:view"]) {
    assert.match(projection, new RegExp(escapeRegex(field)));
  }
  assert.match(contract, /^    trustedAdminAssertion:$/m);
});

test("Agent settings contract uses immutable credential revisions and governance fields", () => {
  const tenantProfile = schemaBlock("TenantAgentProfileDraft");
  for (const field of [
    "credentialVersionId",
    "dataRegion",
    "retentionPolicy",
    "trainingPolicy",
    "maxBudgetUsd",
    "maxTurns",
    "timeoutSeconds",
  ]) assert.match(tenantProfile, new RegExp(`\\b${field}\\b`));
  assert.doesNotMatch(tenantProfile, /\bcredentialId\b|\bbudgetUsd\b|\bfallbackProfileId\b/);

  const adminProfile = schemaBlock("AgentProfileDraft");
  assert.match(adminProfile, /required: \[agent, installationId, credentialVersionId, scope, scopeId,/);
  assert.doesNotMatch(adminProfile, /required: \[[^\n]*\b(?:maxBudgetUsd|maxTurns|timeoutSeconds)\b/);
  assert.match(operationBlock("/admin/agent-defaults/{scope}", "put"), /AgentProfileSelection/);
  assert.match(schemaBlock("AgentSettingsProjection"), /\brotatedAt\b/);
});

test("Agent administration mutations publish exact request-body contracts", () => {
  assert.match(operationBlock("/admin/agent-versions/discover", "post"), /AgentVersionDiscovery/);
  assert.match(operationBlock("/admin/agent-versions/deprecate", "post"), /VersionAction/);
  assert.match(operationBlock("/admin/agent-installations", "post"), /AgentInstallationDraft/);
  assert.match(operationBlock("/admin/agent-profiles/{id}/rebind-installation", "post"), /AgentProfileInstallationRebind/);
  assert.match(operationBlock("/admin/credentials/{id}/rotate", "post"), /CredentialRotation/);
  assert.match(operationBlock("/settings/agents/credentials/{id}/rotate", "post"), /CredentialRotation/);
  assert.match(operationBlock("/settings/agents/credentials/{id}/revoke", "post"), /EmptyObject/);

  for (const path of [
    "/admin/agent-rollouts/{id}/advance",
    "/admin/agent-rollouts/{id}/rollback",
    "/admin/agent-installations/{id}/drain",
    "/admin/agent-installations/{id}/retire",
    "/admin/agent-profiles/{id}/validate",
    "/admin/agent-profiles/{id}/activate",
    "/admin/agent-profiles/{id}/disable",
    "/admin/credentials/{id}/revoke",
  ]) assert.match(operationBlock(path, "post"), /EmptyObject/, path);

  for (const schema of ["CredentialDraft", "CredentialRotation", "AgentVersionDiscovery", "AgentInstallationDraft", "AgentProfileInstallationRebind"]) {
    assert.match(schemaBlock(schema), /additionalProperties: false/, schema);
  }
});

test("production OpenAPI omits localhost fixture authorities and resolves component references", () => {
  for (const localOnly of ["agent-preflight", "agent-run", "local-validation", "/runner/events"]) {
    assert.equal(contract.includes(localOnly), false, `${localOnly} must stay outside the production contract`);
  }

  const paths = [...contract.matchAll(/^  (\/[^:\n]+):$/gm)].map((match) => match[1]);
  assert.equal(new Set(paths).size, paths.length, "OpenAPI paths must be unique");
  const operationIds = [...contract.matchAll(/^      operationId: ([A-Za-z0-9]+)$/gm)].map((match) => match[1]);
  assert.equal(new Set(operationIds).size, operationIds.length, "operationId values must be unique");

  for (const match of contract.matchAll(/#\/components\/(schemas|responses|parameters|requestBodies)\/([A-Za-z0-9]+)/g)) {
    assert.match(contract, new RegExp(`^    ${escapeRegex(match[2])}:`, "m"), `unresolved component ${match[0]}`);
  }
});

function pathBlock(path) {
  const match = contract.match(new RegExp(`^  ${escapeRegex(path)}:\\n([\\s\\S]*?)(?=^  \/|^components:)`, "m"));
  assert.ok(match, `missing OpenAPI path ${path}`);
  return match[1];
}

function operationBlock(path, method) {
  const block = pathBlock(path);
  const marker = `    ${method}:\n`;
  const start = block.indexOf(marker);
  assert.notEqual(start, -1, `missing ${method.toUpperCase()} ${path}`);
  const body = block.slice(start + marker.length);
  const next = body.search(/^    (?:get|post|put|patch|delete|head|options|trace):/m);
  return next === -1 ? body : body.slice(0, next);
}

function schemaBlock(name) {
  const schemas = contract.slice(contract.indexOf("  schemas:\n") + "  schemas:\n".length);
  const marker = `    ${name}:\n`;
  const start = schemas.indexOf(marker);
  assert.notEqual(start, -1, `missing schema ${name}`);
  const body = schemas.slice(start + marker.length);
  const next = body.search(/^    [A-Za-z0-9]+:/m);
  return next === -1 ? body : body.slice(0, next);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
