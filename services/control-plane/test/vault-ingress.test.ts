import assert from "node:assert/strict";
import test from "node:test";
import { VaultIngressSecretVault, type VaultIngressHttp } from "../src/secret-vault";

const tls = { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) };

test("control-plane Vault ingress uses fixed mTLS routes and wipes copied plaintext", async () => {
  const bodies: Buffer[] = [];
  const calls: Array<{ path: string; headers: Readonly<Record<string, string>> }> = [];
  const secretRef = "vault://kv/deviludo/records/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const http: VaultIngressHttp = async (url, input) => {
    if (input.body) bodies.push(input.body);
    calls.push({ path: url.pathname, headers: input.headers });
    if (input.method === "GET") {
      return { statusCode: 200, payload: Buffer.from(JSON.stringify({ status: "ok", service: "deviludo-secret-broker" })) };
    }
    return input.headers["content-type"] === "application/octet-stream"
      ? { statusCode: 201, payload: Buffer.from(JSON.stringify({ secretRef, maskedFingerprint: "sha256:12345678…abcdef" })) }
      : { statusCode: 204, payload: Buffer.alloc(0) };
  };
  const vault = new VaultIngressSecretVault({ endpoint: "https://secret-broker.internal", tls, http });
  await vault.probe();
  assert.equal(calls[0]?.path, "/healthz");
  const plaintext = Buffer.from("provider-key-material");
  assert.equal((await vault.write("credential-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/1", plaintext)).secretRef, secretRef);
  assert.ok(bodies[0]?.every((value) => value === 0));
  assert.equal(calls[1]?.path, "/secrets:write");
  assert.match(calls[1]?.headers["idempotency-key"] ?? "", /^[a-f0-9]{64}$/);
  await vault.revoke(secretRef);
  assert.ok(bodies[1]?.every((value) => value === 0));
  assert.equal(calls[2]?.path, "/secrets:revoke");
});

test("control-plane rejects a credential-free endpoint without mounted mTLS material", () => {
  assert.throws(() => new VaultIngressSecretVault({ endpoint: "http://secret-broker.internal", tls }), /credential-free HTTPS/);
  assert.throws(() => new VaultIngressSecretVault({ endpoint: "https://secret-broker.internal", tls: { ...tls, key: Buffer.alloc(0) } }), /mTLS material/);
});

test("control-plane Vault readiness rejects a response from the wrong service", async () => {
  const vault = new VaultIngressSecretVault({
    endpoint: "https://secret-broker.internal",
    tls,
    http: async () => ({ statusCode: 200, payload: Buffer.from(JSON.stringify({
      status: "ok", service: "attacker-controlled-service",
    })) }),
  });
  await assert.rejects(vault.probe(), /readiness identity is invalid/);
});
