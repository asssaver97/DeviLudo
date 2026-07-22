import assert from "node:assert/strict";
import test from "node:test";
import { VaultKvV2SecretBackend, type VaultHttp } from "../src/vault-backend";

const tls = { ca: Buffer.alloc(64, 1) };
const token = Buffer.from("vault-agent-token");
const readinessRecordId = "00000000-0000-4000-8000-000000000000";
const readinessPaths = [
  "secret/config",
  `secret/data/deviludo/records/${readinessRecordId}`,
  "secret/data/deviludo/static/github-oauth-client-secret",
  `secret/metadata/deviludo/records/${readinessRecordId}`,
] as const;
const readinessCapabilities = Object.freeze({
  [readinessPaths[0]]: ["read"],
  [readinessPaths[1]]: ["create", "read"],
  [readinessPaths[2]]: ["read"],
  [readinessPaths[3]]: ["delete"],
});

interface ReadinessFixture {
  readonly healthStatus?: number;
  readonly health?: unknown;
  readonly configStatus?: number;
  readonly config?: unknown;
  readonly capabilitiesStatus?: number;
  readonly capabilities?: unknown;
}

function readinessBackend(fixture: ReadinessFixture = {}, calls: Array<{
  path: string;
  method: string;
  body: unknown;
  requestBody?: Buffer;
  responseBody: Buffer;
}> = []): VaultKvV2SecretBackend {
  const http: VaultHttp = async (url, input) => {
    const body = input.body ? JSON.parse(input.body.toString("utf8")) as unknown : null;
    let statusCode: number;
    let value: unknown;
    if (url.pathname === "/v1/sys/health") {
      statusCode = fixture.healthStatus ?? 200;
      value = fixture.health ?? { initialized: true, sealed: false, standby: false, version: "1.17.6" };
    } else if (url.pathname === "/v1/secret/config") {
      statusCode = fixture.configStatus ?? 200;
      value = fixture.config ?? { data: { cas_required: false, max_versions: 1, delete_version_after: "0s" } };
    } else if (url.pathname === "/v1/sys/capabilities-self") {
      statusCode = fixture.capabilitiesStatus ?? 200;
      value = fixture.capabilities ?? readinessCapabilities;
    } else {
      throw new Error(`Unexpected Vault readiness request: ${url.pathname}`);
    }
    const responseBody = Buffer.from(JSON.stringify(value));
    calls.push({ path: url.pathname, method: input.method, body, requestBody: input.body, responseBody });
    return { statusCode, payload: responseBody };
  };
  return new VaultKvV2SecretBackend({
    endpoint: "https://vault.internal",
    mount: "secret",
    token,
    tls,
    staticReadPaths: ["static/github-oauth-client-secret"],
    http,
  });
}

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
  assert.throws(() => new VaultKvV2SecretBackend({
    endpoint: "https://vault.internal", mount: "secret", token, tls, staticReadPaths: ["records/not-static"],
  }), /static readiness path is invalid/);
});

test("Vault readiness proves an active KV v2 mount and an exact least-privilege token without reading secrets", async () => {
  const calls: Array<{
    path: string;
    method: string;
    body: unknown;
    requestBody?: Buffer;
    responseBody: Buffer;
  }> = [];
  await readinessBackend({}, calls).probe();

  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["GET", "/v1/sys/health"],
    ["GET", "/v1/secret/config"],
    ["POST", "/v1/sys/capabilities-self"],
  ]);
  assert.deepEqual(calls[2]?.body, { paths: readinessPaths });
  assert.equal(calls.some(({ method, path }) => method === "GET" && path.includes("/data/deviludo/")), false);
  assert.equal(calls.every(({ responseBody }) => responseBody.every((byte) => byte === 0)), true);
  assert.equal(calls[2]?.requestBody?.every((byte) => byte === 0), true);
});

test("Vault readiness fails closed for non-active nodes, wrong mounts and unsafe token capabilities", async (context) => {
  const withoutRecordCreate = { ...readinessCapabilities, [readinessPaths[1]]: ["read"] };
  const overprivilegedRecord = { ...readinessCapabilities, [readinessPaths[1]]: ["create", "read", "update"] };
  const cases: ReadonlyArray<readonly [string, ReadinessFixture]> = [
    ["standby node", { healthStatus: 429, health: { initialized: true, sealed: false, standby: true, version: "1.17.6" } }],
    ["sealed node", { health: { initialized: true, sealed: true, standby: false, version: "1.17.6" } }],
    ["non-KV-v2 mount", { configStatus: 404, config: { errors: ["unsupported path"] } }],
    ["missing create capability", { capabilities: withoutRecordCreate }],
    ["overprivileged record capability", { capabilities: overprivilegedRecord }],
  ];
  for (const [name, fixture] of cases) {
    await context.test(name, async () => {
      await assert.rejects(readinessBackend(fixture).probe(), /Vault readiness probe failed/);
    });
  }
});
