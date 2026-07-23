import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PROVIDER_PROBE_CHECKS, type GatewayProviderProbeRequest } from "../../inference-gateway/src/provider-probe";
import {
  LocalProviderControl,
  LocalProviderControlConflictError,
  LocalProviderProbeError,
} from "../src/provider-control";
import type { LocalAgentPreflightRequest } from "../src/contracts";

const provider: GatewayProviderProbeRequest = Object.freeze({
  providerRevisionId: "provider-claude-r7",
  agent: "claude-code",
  protocol: "anthropic-messages",
  baseUrl: "https://gateway.example.com/v1",
  approvedPorts: Object.freeze([443]),
  authentication: "x-api-key",
  models: Object.freeze({
    primaryModel: "claude-sonnet-4-6-20250514",
    planningModel: "claude-opus-4-6-20250514",
    smallFastModel: "claude-haiku-4-5-20251001",
    subagentModel: "claude-sonnet-4-6-20250514",
  }),
  credentialVersionId: "credential-claude-v7",
  requiredChecks: PROVIDER_PROBE_CHECKS,
});

const preflight: LocalAgentPreflightRequest = Object.freeze({
  projectId: "project-1",
  runId: "run-1",
  profileRevisionId: "profile-claude-r7",
  installationId: "installation-claude-214",
  agent: provider.agent,
  expectedVersion: "2.1.14",
  imageDigest: `sha256:${"a".repeat(64)}`,
  adapterVersion: "1.3.0",
  providerRevisionId: provider.providerRevisionId,
  credentialVersionId: provider.credentialVersionId,
  model: provider.models.primaryModel,
  modelRoles: provider.models,
});

test("local Provider control retains only sidecar secret bytes and binds a passed probe exactly", async () => {
  let probes = 0;
  const control = new LocalProviderControl({
    async run(value) {
      probes += 1;
      assert.deepEqual(value, provider);
      return Object.freeze({
        providerRevisionId: provider.providerRevisionId,
        checks: Object.freeze(Object.fromEntries(PROVIDER_PROBE_CHECKS.map((check) => [check, "PASS"])) as Record<(typeof PROVIDER_PROBE_CHECKS)[number], "PASS">),
      });
    },
  });
  const secret = "sk-local-secret-material";
  const expectedFingerprint = `sha256:${createHash("sha256").update(secret).digest("hex")}`;
  const stored = control.putCredential({ credentialVersionId: provider.credentialVersionId, secret });
  assert.equal(stored.secretRef, `secret://local-agent-runtime/${provider.credentialVersionId}`);
  assert.equal(stored.fingerprint, expectedFingerprint);
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.deepEqual(control.putCredential({ credentialVersionId: provider.credentialVersionId, secret }), stored);
  await assert.rejects(async () => control.putCredential({
    credentialVersionId: provider.credentialVersionId,
    secret: "different-secret-material",
  }), LocalProviderControlConflictError);

  const receipt = await control.probe(provider);
  assert.equal(receipt.state, "READY");
  assert.equal(probes, 1);
  assert.equal(await control.verify(preflight), true);
  assert.equal(await control.verify({ ...preflight, model: "claude-sonnet-4-6-20250515" }), false);
  assert.equal(await control.verify({ ...preflight, credentialVersionId: "credential-claude-v8" }), false);

  control.revokeCredential({ credentialVersionId: provider.credentialVersionId });
  assert.equal(await control.verify(preflight), false);
  await assert.rejects(async () => control.probe(provider), LocalProviderProbeError);
});

test("local Provider control fails closed on invalid or incomplete probe receipts", async () => {
  const control = new LocalProviderControl({
    async run(value) {
      return Object.freeze({
        providerRevisionId: (value as GatewayProviderProbeRequest).providerRevisionId,
        checks: Object.freeze({ authentication: "PASS" }) as never,
      });
    },
  });
  control.putCredential({ credentialVersionId: provider.credentialVersionId, secret: "sk-local-secret-material" });
  await assert.rejects(async () => control.probe(provider), LocalProviderProbeError);
  assert.equal(await control.verify(preflight), false);
  control.close();
});
