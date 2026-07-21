import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TlsRunnerIdentity } from "../src/contracts";
import {
  createRunnerToolchainPublicationHandler,
  createRunnerToolchainPublicationHttpsServer,
} from "../src/toolchain-publication-http";
import {
  RunnerToolchainPublicationConflict,
  type RunnerToolchainPublication,
} from "../src/toolchain-publication";
import { runnerToolchainPublicationConfigFromEnv } from "../src/run-toolchain-publication-service";

const sha = (value: string) => value.repeat(64);
const identity: TlsRunnerIdentity = {
  spiffeId: "spiffe://deviludo.test/supply-chain/runner-toolchain",
  certificateFingerprint: sha("a"),
  certificateSerial: "publisher-01",
  certificateNotAfter: "2031-01-01T00:00:00.000Z",
};
const publication: RunnerToolchainPublication = {
  schemaVersion: "deviludo.runner-toolchain-publication.v1",
  publicationId: "33333333-3333-4333-8333-333333333333",
  tenantId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  requiredGodotVersion: "4.6.2-stable",
  targetMatrix: ["linux"],
  runnerBindings: { linux: { runnerId: "runner-linux-1", capabilityDigest: sha("b") } },
  godotTestKitDigest: sha("1"),
  buildManifestDigest: sha("2"),
  sbomDigest: sha("3"),
  vulnerabilityScanDigest: sha("4"),
  assetLicenseLedgerDigest: sha("5"),
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:10:00.000Z",
};

function request(path: string, body: unknown, socket: unknown = { peer: true }) {
  return {
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    socket,
    rawBody: JSON.stringify(body),
  };
}

test("mTLS publisher ingress admits only its allow-listed workload and strict publication", async () => {
  const calls: string[] = [];
  const handler = createRunnerToolchainPublicationHandler({
    publisher: {
      async probe() { calls.push("probe"); },
      async publish(authoritativeIdentity, input) {
        calls.push(`${authoritativeIdentity.spiffeId}:${input.publicationId}`);
        return {
          schemaVersion: "deviludo.runner-toolchain-publication-receipt.v1",
          publicationId: input.publicationId,
          tenantId: input.tenantId,
          projectId: input.projectId,
          runnerToolchainRevisionId: "44444444-4444-4444-8444-444444444444",
          revision: 1,
          runnerToolchainDigest: sha("6"),
          targetMatrix: input.targetMatrix,
          createdAt: "2030-01-01T00:05:00.000Z",
        };
      },
    },
    allowedSpiffeIds: new Set([identity.spiffeId]),
    now: () => new Date("2030-01-01T00:05:00.000Z"),
    extractIdentity: () => identity,
  });
  const created = await handler(request("/v1/runner-toolchains", publication));
  assert.equal(created.status, 201);
  assert.equal(calls.length, 1);
  const health = await handler(request("/healthz", {}));
  assert.equal(health.status, 200);
  assert.deepEqual(calls, [`${identity.spiffeId}:${publication.publicationId}`, "probe"]);

  const forbidden = createRunnerToolchainPublicationHandler({
    publisher: { probe: async () => undefined, publish: async () => { throw new Error("must not run"); } },
    allowedSpiffeIds: new Set(["spiffe://deviludo.test/another-workload"]),
    extractIdentity: () => identity,
  });
  assert.equal((await forbidden(request("/v1/runner-toolchains", publication))).status, 403);
});
test("publisher ingress separates invalid, conflict and unavailable responses without leaking errors", async () => {
  const conflict = createRunnerToolchainPublicationHandler({
    publisher: {
      probe: async () => undefined,
      publish: async () => { throw new RunnerToolchainPublicationConflict("DATABASE_URL=password"); },
    },
    allowedSpiffeIds: new Set([identity.spiffeId]),
    now: () => new Date("2030-01-01T00:05:00.000Z"),
    extractIdentity: () => identity,
  });
  const conflicted = await conflict(request("/v1/runner-toolchains", publication));
  assert.deepEqual(conflicted, {
    status: 409,
    body: { error: { code: "RUNNER_TOOLCHAIN_PUBLICATION_CONFLICT" } },
  });
  assert.doesNotMatch(JSON.stringify(conflicted), /DATABASE_URL|password/);
  assert.equal((await conflict({ ...request("/v1/runner-toolchains", publication), rawBody: "{" })).status, 400);
  assert.equal((await conflict({ ...request("/v1/runner-toolchains", publication), headers: { "content-type": "text/plain" } })).status, 415);

  const unavailable = createRunnerToolchainPublicationHandler({
    publisher: { probe: async () => { throw new Error("secret"); }, publish: async () => { throw new Error("secret"); } },
    allowedSpiffeIds: new Set([identity.spiffeId]),
    now: () => new Date("2030-01-01T00:05:00.000Z"),
    extractIdentity: () => identity,
  });
  assert.equal((await unavailable(request("/healthz", {}))).status, 503);
  assert.equal((await unavailable(request("/v1/runner-toolchains", publication))).status, 503);
});

test("publisher HTTPS boundary and production config require isolated TLS material", async () => {
  const handler = createRunnerToolchainPublicationHandler({
    publisher: { probe: async () => undefined, publish: async () => { throw new Error("unused"); } },
    allowedSpiffeIds: new Set([identity.spiffeId]),
    extractIdentity: () => identity,
  });
  assert.throws(() => createRunnerToolchainPublicationHttpsServer({ tls: {}, handler }), /TLS material is incomplete/);
  assert.throws(() => createRunnerToolchainPublicationHttpsServer({
    tls: { key: "key", cert: "cert", ca: "ca" }, handler, maxBodyBytes: 100,
  }), /body limit/);

  const directory = await mkdtemp(join(tmpdir(), "deviludo-toolchain-publisher-"));
  try {
    const key = join(directory, "tls.key");
    const cert = join(directory, "tls.crt");
    const ca = join(directory, "ca.crt");
    await Promise.all([
      writeFile(key, Buffer.alloc(64, 1)),
      writeFile(cert, Buffer.alloc(64, 2)),
      writeFile(ca, Buffer.alloc(64, 3)),
    ]);
    const config = await runnerToolchainPublicationConfigFromEnv({
      NODE_ENV: "production",
      DEVILUDO_RUNNER_TOOLCHAIN_HOST: "::",
      DEVILUDO_RUNNER_TOOLCHAIN_PORT: "4866",
      DEVILUDO_RUNNER_TOOLCHAIN_MAX_BODY_BYTES: "8192",
      DEVILUDO_RUNNER_TOOLCHAIN_TLS_KEY_FILE: key,
      DEVILUDO_RUNNER_TOOLCHAIN_TLS_CERT_FILE: cert,
      DEVILUDO_RUNNER_TOOLCHAIN_CLIENT_CA_FILE: ca,
      DEVILUDO_RUNNER_TOOLCHAIN_ALLOWED_SPIFFE_IDS: JSON.stringify([identity.spiffeId]),
    });
    assert.equal(config.host, "::");
    assert.equal(config.port, 4866);
    assert.equal(config.maxBodyBytes, 8192);
    assert.ok(config.allowedSpiffeIds.has(identity.spiffeId));
    await assert.rejects(runnerToolchainPublicationConfigFromEnv({ NODE_ENV: "test" }), /requires NODE_ENV=production/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
