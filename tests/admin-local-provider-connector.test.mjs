import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/admin/[...segments]/route.ts";
import { getDemoStore, resetDemoStore } from "../lib/control-plane/demo-store.ts";
import { PROVIDER_PROBE_CHECKS } from "../services/inference-gateway/src/provider-probe.ts";
import { LocalProviderControl } from "../services/local-agent-runtime/src/provider-control.ts";
import { LocalAgentRuntimeRequestVerifier } from "../services/local-agent-runtime/src/request-auth.ts";

const context = (path) => ({ params: Promise.resolve({ segments: path.split("/") }) });

function command(path, role, body, idempotency = crypto.randomUUID()) {
  return new Request(`http://127.0.0.1:3000/api/admin/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `provider-connector-${idempotency}`,
      "x-deviludo-role": role,
    },
    body: JSON.stringify(body),
  });
}

test("local admin stores Provider keys in the authenticated sidecar and activates only a real probe receipt", async () => {
  resetDemoStore();
  const previous = {
    required: process.env.DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED,
    url: process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_URL,
    key: process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY,
    fetch: globalThis.fetch,
  };
  const encodedKey = Buffer.alloc(32, 19).toString("base64url");
  let probed;
  let probeCount = 0;
  let failProbe = false;
  const createProviderControl = () => new LocalProviderControl({
    async run(value) {
      if (failProbe) throw new Error("synthetic Provider probe failure");
      probeCount += 1;
      probed = value;
      return Object.freeze({
        providerRevisionId: value.providerRevisionId,
        checks: Object.freeze(Object.fromEntries(PROVIDER_PROBE_CHECKS.map((check) => [check, "PASS"]))),
      });
    },
  });
  let providerControl = createProviderControl();
  const verifier = new LocalAgentRuntimeRequestVerifier(new Uint8Array(Buffer.from(encodedKey, "base64url")));
  process.env.DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED = "1";
  process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_URL = "http://127.0.0.1:4312";
  process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY = encodedKey;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.toString());
    assert.equal(url.origin, "http://127.0.0.1:4312");
    const body = String(init?.body ?? "");
    verifier.verify({ method: "POST", path: url.pathname, body, headers: init?.headers ?? {} });
    const command = JSON.parse(body);
    if (url.pathname === "/v1/provider-credentials") {
      return jsonResponse(201, providerControl.putCredential(command));
    }
    if (url.pathname === "/v1/provider-probes") {
      try {
        return jsonResponse(200, await providerControl.probe(command));
      } catch {
        return new Response(JSON.stringify({ error: { code: "LOCAL_PROVIDER_PROBE_FAILED" } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.pathname === "/v1/provider-bindings/rebind") {
      return jsonResponse(200, providerControl.rebind(command));
    }
    if (url.pathname === "/v1/provider-bindings/check") {
      return jsonResponse(200, providerControl.checkBinding(command));
    }
    if (url.pathname === "/v1/provider-bindings/activate") {
      return jsonResponse(200, providerControl.activate(command));
    }
    if (url.pathname === "/v1/provider-bindings/disable") {
      return jsonResponse(200, providerControl.disable(command));
    }
    if (url.pathname === "/v1/provider-credentials/revoke") {
      return jsonResponse(200, providerControl.revokeCredential(command));
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
  };

  try {
    const secret = "sk-connector-only-secret-material";
    const credentialResponse = await POST(command("credentials", "SecurityAdmin", {
      label: "Connector credential",
      apiKey: secret,
    }, "credential"), context("credentials"));
    assert.equal(credentialResponse.status, 201);
    const credential = (await credentialResponse.json()).data;
    assert.equal(JSON.stringify(credential).includes(secret), false);

    const profileResponse = await POST(command("agent-profiles", "SecurityAdmin", {
      agent: "claude-code",
      installationId: "claude-installation-214",
      credentialVersionId: credential.id,
      scope: "platform",
      scopeId: "global",
      baseUrl: "https://gateway.example.com/v1",
      authentication: "x-api-key",
      primaryModel: "claude-sonnet-4-6-20250514",
      planningModel: "claude-opus-4-6-20250514",
      smallFastModel: "claude-haiku-4-5-20251001",
      subagentModel: "claude-sonnet-4-6-20250514",
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      dataRegion: "EU",
      retentionPolicy: "Zero retention",
      trainingPolicy: "No training",
      maxBudgetUsd: 20,
      maxTurns: 64,
      timeoutSeconds: 7200,
    }, "profile"), context("agent-profiles"));
    assert.equal(profileResponse.status, 201);
    const profile = (await profileResponse.json()).data.profile;

    const validateResponse = await POST(command(`agent-profiles/${profile.id}/validate`, "SecurityAdmin", {}, "validate"), context(`agent-profiles/${profile.id}/validate`));
    assert.equal(validateResponse.status, 201);
    const validated = (await validateResponse.json()).data;
    assert.equal(validated.profile.state, "READY");
    assert.equal(validated.provider.state, "READY");
    assert.equal(PROVIDER_PROBE_CHECKS.every((check) => validated.provider.probe[check] === "PASS"), true);
    assert.equal(probed.credentialVersionId, credential.id);
    assert.equal(JSON.stringify(probed).includes(secret), false);

    const activateResponse = await POST(command(`agent-profiles/${profile.id}/activate`, "SecurityAdmin", {}, "activate"), context(`agent-profiles/${profile.id}/activate`));
    assert.equal(activateResponse.status, 201);
    assert.equal((await activateResponse.json()).data.profile.state, "ACTIVE");

    const store = getDemoStore();
    const sourceInstallation = store.installations.find((item) => item.id === profile.installationId);
    assert.ok(sourceInstallation);
    const successorInstallationId = "claude-installation-provider-rebind-test";
    store.installations.push({
      ...sourceInstallation,
      id: successorInstallationId,
      workerPool: "development-provider-rebind-test",
      imageDigest: `sha256:${"d".repeat(64)}`,
      buildReceiptId: "build-provider-rebind-test",
      buildReceiptDigest: `sha256:${"e".repeat(64)}`,
      activatedAt: new Date().toISOString(),
    });
    const rebindPath = `agent-profiles/${profile.id}/rebind-installation`;
    const rebindResponse = await POST(command(rebindPath, "PlatformAgentAdmin", {
      installationId: successorInstallationId,
    }, "rebind"), context(rebindPath));
    assert.equal(rebindResponse.status, 201);
    const successor = (await rebindResponse.json()).data.profile;
    assert.equal(successor.state, "READY");
    assert.equal(successor.providerRevisionId, profile.providerRevisionId);
    assert.equal(store.profiles.find((item) => item.id === profile.id)?.state, "ACTIVE");

    const successorActivation = await POST(command(
      `agent-profiles/${successor.id}/activate`, "SecurityAdmin", {}, "activate-successor",
    ), context(`agent-profiles/${successor.id}/activate`));
    assert.equal(successorActivation.status, 201);
    assert.equal((await successorActivation.json()).data.profile.state, "ACTIVE");
    assert.equal(store.profiles.find((item) => item.id === profile.id)?.state, "ACTIVE");

    store.defaults.platform = profile.id;
    const rotatePath = `credentials/${credential.id}/rotate`;
    const rotatedResponse = await POST(command(rotatePath, "SecurityAdmin", {
      apiKey: "sk-connector-rotated-secret-material",
    }, "rotate-active"), context(rotatePath));
    assert.equal(rotatedResponse.status, 201);
    const rotatedText = await rotatedResponse.text();
    assert.equal(rotatedText.includes("sk-connector-rotated-secret-material"), false);
    const rotation = JSON.parse(rotatedText).data;
    assert.equal(rotation.previousId, credential.id);
    assert.equal(rotation.successorProfileRevisionIds.length, 2);
    assert.equal(rotation.reboundDefaultCount, 1);
    assert.equal(store.credentials.find((item) => item.id === credential.id)?.state, "PREVIOUS");
    assert.equal(store.credentials.find((item) => item.id === rotation.id)?.state, "ACTIVE");
    assert.equal(store.profiles.find((item) => item.id === profile.id)?.state, "SUPERSEDED");
    assert.equal(store.profiles.find((item) => item.id === successor.id)?.state, "SUPERSEDED");
    assert.equal(store.providers.find((item) => item.id === profile.providerRevisionId)?.state, "DISABLED");
    const rotationProfiles = rotation.successorProfileRevisionIds
      .map((id) => store.profiles.find((item) => item.id === id));
    assert.equal(rotationProfiles.every((item) => item?.state === "ACTIVE"), true);
    assert.equal(store.defaults.platform, rotationProfiles.find((item) => item?.revision === profile.revision + 1)?.id);
    const rotationProvider = store.providers.find((item) => item.id === rotationProfiles[0]?.providerRevisionId);
    assert.equal(rotationProvider?.state, "ACTIVE");
    assert.equal(rotationProvider?.credentialVersionId, rotation.id);
    assert.equal(providerControl.checkBinding({
      providerRevisionId: rotationProvider.id,
      profileRevisionId: rotationProfiles[0].id,
      credentialVersionId: rotation.id,
      agent: rotationProfiles[0].agent,
      modelRoles: rotationProvider.models,
    }).active, true);

    const failedRotationPath = `credentials/${rotation.id}/rotate`;
    failProbe = true;
    const failedRotation = await POST(command(failedRotationPath, "SecurityAdmin", {
      apiKey: "sk-connector-probe-failure-material",
    }, "rotate-after-probe-failure"), context(failedRotationPath));
    assert.equal(failedRotation.status, 422);
    assert.equal((await failedRotation.json()).error.code, "PROVIDER_PROBE_FAILED");
    assert.equal(store.credentials.filter((item) => item.familyId === credential.familyId).length, 2);
    assert.equal(store.credentials.find((item) => item.id === rotation.id)?.state, "ACTIVE");
    assert.equal(store.defaults.platform, rotationProfiles.find((item) => item?.revision === profile.revision + 1)?.id);
    assert.equal(rotationProfiles.every((item) => item?.state === "ACTIVE"), true);

    failProbe = false;
    const retryRotation = await POST(command(failedRotationPath, "SecurityAdmin", {
      apiKey: "sk-connector-probe-failure-material",
    }, "rotate-after-probe-failure"), context(failedRotationPath));
    assert.equal(retryRotation.status, 201);
    const retried = (await retryRotation.json()).data;
    assert.equal(store.credentials.find((item) => item.id === rotation.id)?.state, "PREVIOUS");
    assert.equal(store.credentials.find((item) => item.id === retried.id)?.state, "ACTIVE");
    const credentialCountAfterRetry = store.credentials.length;
    const replay = await POST(command(failedRotationPath, "SecurityAdmin", {
      apiKey: "this-material-must-not-reach-the-sidecar",
    }, "rotate-after-probe-failure"), context(failedRotationPath));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).meta.idempotentReplay, true);
    assert.equal(store.credentials.length, credentialCountAfterRetry);

    const currentProfiles = retried.successorProfileRevisionIds
      .map((id) => store.profiles.find((item) => item.id === id));
    const currentProvider = store.providers.find((item) => item.id === currentProfiles[0].providerRevisionId);
    const currentDefault = store.defaults.platform;
    providerControl.close();
    providerControl = createProviderControl();
    assert.equal(providerControl.checkBinding({
      providerRevisionId: currentProvider.id,
      profileRevisionId: currentProfiles[0].id,
      credentialVersionId: retried.id,
      agent: currentProfiles[0].agent,
      modelRoles: currentProvider.models,
    }).active, false);

    const restorePath = `credentials/${retried.id}/restore-local-binding`;
    const wrongRestore = await POST(command(restorePath, "SecurityAdmin", {
      apiKey: "sk-wrong-credential-material",
    }, "restore-wrong-fingerprint"), context(restorePath));
    assert.equal(wrongRestore.status, 409);
    assert.equal((await wrongRestore.json()).error.code, "CREDENTIAL_RESTORE_FINGERPRINT_MISMATCH");
    assert.equal(store.defaults.platform, currentDefault);

    failProbe = true;
    const failedRestore = await POST(command(restorePath, "SecurityAdmin", {
      apiKey: "sk-connector-probe-failure-material",
    }, "restore-after-restart"), context(restorePath));
    assert.equal(failedRestore.status, 422);
    assert.equal((await failedRestore.json()).error.code, "PROVIDER_PROBE_FAILED");
    assert.equal(store.defaults.platform, currentDefault);
    assert.equal(currentProfiles.every((item) => item.state === "ACTIVE"), true);

    failProbe = false;
    const restoredResponse = await POST(command(restorePath, "SecurityAdmin", {
      apiKey: "sk-connector-probe-failure-material",
    }, "restore-after-restart"), context(restorePath));
    assert.equal(restoredResponse.status, 201);
    const restoredText = await restoredResponse.text();
    assert.equal(restoredText.includes("sk-connector-probe-failure-material"), false);
    const restored = JSON.parse(restoredText).data;
    assert.deepEqual(restored.restoredProfileRevisionIds.toSorted(), currentProfiles.map((item) => item.id).toSorted());
    assert.equal(restored.revalidatedCount, 2);
    assert.equal(restored.alreadyActiveCount, 0);
    assert.equal(restored.credentialVersionUnchanged, true);
    assert.equal(store.credentials.length, credentialCountAfterRetry);
    assert.equal(store.defaults.platform, currentDefault);
    assert.equal(providerControl.checkBinding({
      providerRevisionId: currentProvider.id,
      profileRevisionId: currentProfiles[0].id,
      credentialVersionId: retried.id,
      agent: currentProfiles[0].agent,
      modelRoles: currentProvider.models,
    }).active, true);
    const probeCountAfterRestore = probeCount;
    const alreadyActiveRestore = await POST(command(restorePath, "SecurityAdmin", {
      apiKey: "sk-connector-probe-failure-material",
    }, "restore-already-active"), context(restorePath));
    assert.equal(alreadyActiveRestore.status, 201);
    const alreadyActive = (await alreadyActiveRestore.json()).data;
    assert.equal(alreadyActive.alreadyActiveCount, 2);
    assert.equal(alreadyActive.revalidatedCount, 0);
    assert.equal(probeCount, probeCountAfterRestore);
    assert.equal(store.audit.filter((event) => event.action === "CREDENTIAL_BINDINGS_RESTORED").length, 2);
    const restoredReplay = await POST(command(restorePath, "SecurityAdmin", {
      apiKey: "this-secret-must-not-reach-the-sidecar",
    }, "restore-after-restart"), context(restorePath));
    assert.equal(restoredReplay.status, 200);
    assert.equal((await restoredReplay.json()).meta.idempotentReplay, true);

    const revokeResponse = await POST(command(`credentials/${retried.id}/revoke`, "SecurityAdmin", {}, "revoke"), context(`credentials/${retried.id}/revoke`));
    assert.equal(revokeResponse.status, 201);
    assert.equal((await revokeResponse.json()).data.degradedProfiles, 2);
    const projection = await GET(new Request("http://127.0.0.1:3000/api/admin/agents", {
      headers: { "x-deviludo-role": "SecurityAdmin" },
    }), context("agents"));
    const current = await projection.json();
    assert.equal(current.meta.profiles.find((item) => item.id === profile.id).state, "SUPERSEDED");
    assert.equal(currentProfiles.every((item) => current.meta.profiles.find((profile) => profile.id === item.id).state === "DEGRADED"), true);
  } finally {
    providerControl.close();
    globalThis.fetch = previous.fetch;
    restore("DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED", previous.required);
    restore("DEVILUDO_LOCAL_AGENT_RUNTIME_URL", previous.url);
    restore("DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY", previous.key);
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
