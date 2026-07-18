import assert from "node:assert/strict";
import test from "node:test";
import { MtlsGatewayCredentialResolver } from "../../inference-gateway/src/credential-broker";
import { MtlsGitHubAuthorizationSecretClient } from "../../scm-proxy/src/github-auth-secret-client";
import type { InferenceCredentialAuthority } from "../src/contracts";
import { createSecretBrokerHandler } from "../src/http";
import { SecretBrokerService } from "../src/service";
import { MemorySecretBrokerStore } from "../src/store";
import { MemorySecretBackend } from "../src/vault-backend";

const control = "spiffe://deviludo.internal/control/control-plane";
const github = "spiffe://deviludo.internal/control/identity";
const inference = "spiffe://deviludo.internal/inference/gateway";
const tls = Object.freeze({
  key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3),
});

class MutableAuthority implements InferenceCredentialAuthority {
  secretRef = "";
  async resolveRun() { return this.secretRef; }
  async resolveProbe() { return this.secretRef; }
  async probe() {}
}

test("existing GitHub and Inference clients compose with the shared Secret Broker contract", async () => {
  const store = new MemorySecretBrokerStore();
  const backend = new MemorySecretBackend();
  const authority = new MutableAuthority();
  const service = new SecretBrokerService({ store, backend, authority,
    staticGitHubSecretRefs: new Set(["vault://kv/deviludo/static/github-oauth-client-secret"]) });
  const handler = createSecretBrokerHandler({
    service,
    controlPlaneSpiffeIds: new Set([control]),
    githubSpiffeIds: new Set([github]),
    inferenceGatewaySpiffeIds: new Set([inference]),
    extractIdentity: (socket) => ({ spiffeId: String(socket) }),
  });

  const githubClient = new MtlsGitHubAuthorizationSecretClient({
    endpoint: "https://secret-broker.internal",
    tls,
    http: async (url, input) => {
      const response = await handler({
        method: input.method, path: url.pathname, headers: input.headers,
        socket: github, body: input.body ?? Buffer.alloc(0),
      });
      return { statusCode: response.status, contentType: response.contentType, payload: response.body };
    },
  });
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const verifier = "A".repeat(43);
  const pkceRef = await githubClient.put(verifier, expiresAt);
  assert.equal(await githubClient.take(pkceRef), verifier);
  assert.equal(await githubClient.take(pkceRef), null);

  backend.values.set("static/github-oauth-client-secret", Buffer.from("github-client-secret"));
  const staticLease = await githubClient.resolve("vault://kv/deviludo/static/github-oauth-client-secret");
  assert.equal(staticLease.value, "github-client-secret");
  staticLease.destroy();
  assert.throws(() => staticLease.value, /destroyed/);
  await assert.rejects(
    githubClient.resolve("vault://kv/deviludo/static/another-secret"),
    /contract is invalid/,
  );
  await githubClient.probe();

  const provider = await service.writeProviderCredential({
    path: "credential-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1",
    plaintext: Buffer.from("provider-key-secret-value"), workloadSpiffeId: control,
  });
  authority.secretRef = provider.secretRef;
  const gatewayClient = new MtlsGatewayCredentialResolver({
    endpoint: "https://secret-broker.internal/v1/inference-credentials/resolve",
    tls,
    http: async (url, input) => {
      const response = await handler({
        method: input.method, path: url.pathname, headers: input.headers,
        socket: inference, body: Buffer.from(input.body ?? ""),
      });
      try {
        return { statusCode: response.status, payload: JSON.parse(response.body.toString("utf8")) as unknown };
      } finally { response.body.fill(0); }
    },
  });
  const lease = await gatewayClient.resolve({
    tenantId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    runId: "33333333-3333-4333-8333-333333333333",
    providerRevisionId: "provider-claude-r1",
    credentialVersionId: "credential-a-v1",
  });
  assert.equal(Buffer.from(lease.value).toString("utf8"), "provider-key-secret-value");
  lease.destroy();
  assert.ok([...lease.value].every((value) => value === 0));
  await gatewayClient.probe();
});
