import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/admin/[...segments]/route.ts";
import { resetDemoStore } from "../lib/control-plane/demo-store.ts";
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
  const providerControl = new LocalProviderControl({
    async run(value) {
      probed = value;
      return Object.freeze({
        providerRevisionId: value.providerRevisionId,
        checks: Object.freeze(Object.fromEntries(PROVIDER_PROBE_CHECKS.map((check) => [check, "PASS"]))),
      });
    },
  });
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
      return jsonResponse(200, await providerControl.probe(command));
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

    const revokeResponse = await POST(command(`credentials/${credential.id}/revoke`, "SecurityAdmin", {}, "revoke"), context(`credentials/${credential.id}/revoke`));
    assert.equal(revokeResponse.status, 201);
    assert.equal((await revokeResponse.json()).data.degradedProfiles, 1);
    const projection = await GET(new Request("http://127.0.0.1:3000/api/admin/agents", {
      headers: { "x-deviludo-role": "SecurityAdmin" },
    }), context("agents"));
    const current = await projection.json();
    assert.equal(current.meta.profiles.find((item) => item.id === profile.id).state, "DEGRADED");
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
