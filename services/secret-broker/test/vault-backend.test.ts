import assert from "node:assert/strict";
import test from "node:test";
import { VaultKvV2SecretBackend, type VaultHttp } from "../src/vault-backend";

const tls = { ca: Buffer.alloc(64, 1) };
const token = Buffer.from("vault-agent-token");

test("Vault KV backend pins HTTPS paths, CAS create and metadata destruction", async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const secret = Buffer.from("upstream-provider-secret");
  const http: VaultHttp = async (url, input) => {
    const body = input.body ? JSON.parse(input.body.toString("utf8")) as unknown : null;
    calls.push({ path: url.pathname, method: input.method, body });
    if (input.method === "POST") return { statusCode: 200, payload: Buffer.from("{}") };
    if (input.method === "GET" && url.pathname.includes("/data/")) {
      return { statusCode: 200, payload: Buffer.from(JSON.stringify({ data: { data: { encoding: "base64", value: secret.toString("base64") } } })) };
    }
    if (input.method === "DELETE") return { statusCode: 204, payload: Buffer.alloc(0) };
    return { statusCode: 200, payload: Buffer.from("{}") };
  };
  const backend = new VaultKvV2SecretBackend({ endpoint: "https://vault.internal", mount: "secret", token, tls, http });
  const path = "records/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await backend.create(path, secret);
  const read = await backend.read(path);
  assert.deepEqual(read, secret); read?.fill(0);
  await backend.destroy(path);
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ["POST", `/v1/secret/data/deviludo/${path}`],
    ["GET", `/v1/secret/data/deviludo/${path}`],
    ["DELETE", `/v1/secret/metadata/deviludo/${path}`],
  ]);
  assert.deepEqual((calls[0]?.body as { options: unknown }).options, { cas: 0 });
  assert.equal(JSON.stringify(calls).includes("vault-agent-token"), false);
});

test("Vault backend rejects plaintext HTTP and paths outside the Broker namespace", () => {
  assert.throws(() => new VaultKvV2SecretBackend({ endpoint: "http://vault.internal", mount: "secret", token, tls }), /HTTPS origin/);
  const backend = new VaultKvV2SecretBackend({ endpoint: "https://vault.internal", mount: "secret", token, tls,
    http: async () => ({ statusCode: 404, payload: Buffer.alloc(0) }) });
  assert.rejects(backend.read("../tenant-secret"), /path is invalid/);
});
