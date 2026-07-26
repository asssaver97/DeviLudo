import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "../../runner-control/src/canonical";
import {
  AgentSupplyChainPolicyFailure,
  createAgentSupplyChain,
  DevelopmentAgentSupplyChain,
  MtlsAgentSupplyChain,
  type AgentSupplyChainHttp,
} from "../src/agent-supply-chain";

const operation = Object.freeze({ operationKey: "a".repeat(64), requestDigest: "b".repeat(64) });
const now = () => new Date("2030-01-01T00:00:00.000Z");

test("development supply-chain executes discovery, validation, immutable image build and staged rollout", async () => {
  const chain = new DevelopmentAgentSupplyChain(now);
  const [candidate] = await chain.discover({ ...operation, agent: "claude-code", requestedVersion: "2.1.15" });
  assert.equal(candidate?.version, "2.1.15");
  const validation = await chain.validateVersion({ ...operation, candidate: candidate! });
  assert.equal(validation.signatureVerified, true);
  assert.equal(validation.scan, "PASS");
  assert.equal(validation.validatedAdapterVersion, "1.3.0");
  assert.deepEqual(validation.adapterCompatibility, { min: "1.3.0", maxExclusive: "1.3.1" });
  const build = await chain.buildInstallation({
    ...operation,
    installationId: "claude-code-installation-test-001",
    candidate: candidate!,
    validation,
    workerPool: "development-linux-canary",
    adapterVersion: "1.3.0",
    rollbackInstallationId: "claude-code-installation-active-001",
  });
  assert.deepEqual(build.stages, ["BUILDING", "SCANNING", "SMOKE_TESTING", "READY"]);
  assert.match(build.imageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(build.selfUpdateDisabled, true);
  const rollout = await chain.rollout({
    ...operation,
    installationId: build.installationId,
    imageDigest: build.imageDigest,
    action: "ADVANCE",
    fromPercent: 0,
    toPercent: 5,
    runtimeBinding: build.runtimeBinding,
  });
  assert.equal(rollout.state, "CANARY");
  assert.equal(rollout.newTasksOnly, true);
  await assert.rejects(chain.rollout({
    ...operation,
    installationId: build.installationId,
    imageDigest: build.imageDigest,
    action: "ADVANCE",
    fromPercent: 5,
    toPercent: 100,
    runtimeBinding: build.runtimeBinding,
  }), /receipt is invalid/);
  await chain.rollout({ ...operation, installationId: build.installationId, imageDigest: build.imageDigest,
    action: "ADVANCE", fromPercent: 5, toPercent: 25, runtimeBinding: build.runtimeBinding });
  await chain.rollout({ ...operation, installationId: build.installationId, imageDigest: build.imageDigest,
    action: "ADVANCE", fromPercent: 25, toPercent: 100, runtimeBinding: build.runtimeBinding });
  const draining = await chain.rollout({ ...operation, installationId: build.installationId, imageDigest: build.imageDigest,
    action: "DRAIN", fromPercent: 100, toPercent: 0, runtimeBinding: build.runtimeBinding });
  assert.equal(draining.state, "DRAINING");
  assert.equal(draining.runningTasksUnaffected, true);
  const retired = await chain.rollout({ ...operation, installationId: build.installationId, imageDigest: build.imageDigest,
    action: "RETIRE", fromPercent: 0, toPercent: 0, runtimeBinding: build.runtimeBinding });
  assert.equal(retired.state, "RETIRED");
});

test("mTLS supply-chain client pins routes, health identity and exact receipt digests", async () => {
  const fixture = new DevelopmentAgentSupplyChain(now);
  const [candidate] = await fixture.discover({ ...operation, agent: "codex-cli", requestedVersion: "0.92.0" });
  const validation = await fixture.validateVersion({ ...operation, candidate: candidate! });
  await assert.rejects(fixture.buildInstallation({
    ...operation,
    installationId: "codex-cli-installation-incompatible-001",
    candidate: candidate!, validation,
    workerPool: "development-linux-canary", adapterVersion: "1.2.0", rollbackInstallationId: null,
  }), /receipt is invalid/);
  const buildInput = {
    ...operation,
    installationId: "codex-cli-installation-test-001",
    candidate: candidate!, validation,
    workerPool: "development-linux-canary", adapterVersion: "1.2.2", rollbackInstallationId: null,
  } as const;
  const build = await fixture.buildInstallation(buildInput);
  const rolloutInput = {
    ...operation, installationId: build.installationId, imageDigest: build.imageDigest,
    action: "ADVANCE" as const, fromPercent: 0 as const, toPercent: 5 as const,
    runtimeBinding: build.runtimeBinding,
  };
  const rollout = await fixture.rollout(rolloutInput);
  const paths: string[] = [];
  const http: AgentSupplyChainHttp = async ({ url, body }) => {
    paths.push(url.pathname);
    assert.doesNotMatch(body, /apiKey|credential|password|secretRef/i);
    if (url.pathname === "/healthz") return { statusCode: 200, payload: {
      schemaVersion: "deviludo.agent-supply-chain-health.v1", service: "deviludo-agent-supply-chain",
      version: "1.4.2", binaryDigest: "c".repeat(64), status: "READY", checkedAt: now().toISOString(),
    } };
    if (url.pathname.endsWith("/discover")) return { statusCode: 200, payload: {
      schemaVersion: "deviludo.agent-version-discovery-receipt.v1", candidates: [candidate],
    } };
    if (url.pathname.endsWith("/validate")) return { statusCode: 200, payload: validation };
    if (url.pathname.endsWith("/build")) return { statusCode: 200, payload: build };
    return { statusCode: 200, payload: rollout };
  };
  const client = new MtlsAgentSupplyChain({
    endpoint: "https://agent-supply-chain.internal",
    tls: { key: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    version: "1.4.2", binaryDigest: "c".repeat(64), http,
  });
  await client.probe();
  assert.deepEqual(await client.discover({ ...operation, agent: "codex-cli", requestedVersion: "0.92.0" }), [candidate]);
  assert.deepEqual(await client.validateVersion({ ...operation, candidate: candidate! }), validation);
  assert.deepEqual(await client.buildInstallation(buildInput), build);
  assert.deepEqual(await client.rollout(rolloutInput), rollout);
  assert.deepEqual(paths, ["/healthz", "/v1/agent-versions/discover", "/v1/agent-versions/validate",
    "/v1/agent-installations/build", "/v1/agent-installations/rollout"]);

  const tampered = new MtlsAgentSupplyChain({
    endpoint: "https://agent-supply-chain.internal", version: "1.4.2", binaryDigest: "c".repeat(64),
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
    async http() { return { statusCode: 200, payload: { ...validation, integrity: `sha256:${"f".repeat(64)}` } }; },
  });
  await assert.rejects(tampered.validateVersion({ ...operation, candidate: candidate! }), /receipt is invalid/);
  const adapterTampered = new MtlsAgentSupplyChain({
    endpoint: "https://agent-supply-chain.internal", version: "1.4.2", binaryDigest: "c".repeat(64),
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
    async http() {
      return { statusCode: 200, payload: {
        ...validation,
        adapterCompatibility: { min: validation.validatedAdapterVersion, maxExclusive: "9.9.9" },
      } };
    },
  });
  await assert.rejects(adapterTampered.validateVersion({ ...operation, candidate: candidate! }), /receipt is invalid/);
  const rolloutTampered = new MtlsAgentSupplyChain({
    endpoint: "https://agent-supply-chain.internal", version: "1.4.2", binaryDigest: "c".repeat(64),
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
    async http() {
      return { statusCode: 200, payload: {
        ...rollout,
        runtimeBinding: { ...rollout.runtimeBinding, workerBindingDigest: "f".repeat(64) },
      } };
    },
  });
  await assert.rejects(rolloutTampered.rollout(rolloutInput), /receipt is invalid/);
  assert.throws(() => new MtlsAgentSupplyChain({
    endpoint: "https://agent-supply-chain.internal?token=bad", version: "latest", binaryDigest: "c".repeat(64),
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /configuration is invalid/);

  const failureCore = Object.freeze({
    schemaVersion: "deviludo.agent-supply-chain-terminal-failure.v1" as const,
    operationKey: operation.operationKey,
    requestDigest: operation.requestDigest,
    operationKind: "VALIDATE" as const,
    disposition: "REJECTED" as const,
    failureCode: "SIGNATURE_INVALID" as const,
    evidenceDigest: "e".repeat(64),
    failureReceiptId: "failure-codex-signature-001",
    failedAt: now().toISOString(),
  });
  const failure = Object.freeze({ ...failureCore, failureReceiptDigest: sha256Canonical(failureCore) });
  const rejected = new MtlsAgentSupplyChain({
    endpoint: "https://agent-supply-chain.internal", version: "1.4.2", binaryDigest: "c".repeat(64),
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
    async http() { return { statusCode: 422, payload: { error: { code: "AGENT_SUPPLY_CHAIN_POLICY_REJECTED", failure } } }; },
  });
  await assert.rejects(rejected.validateVersion({ ...operation, candidate: candidate! }), (error) => {
    assert.ok(error instanceof AgentSupplyChainPolicyFailure);
    assert.equal(error.receipt.failureCode, "SIGNATURE_INVALID");
    return true;
  });
  const forged = new MtlsAgentSupplyChain({
    endpoint: "https://agent-supply-chain.internal", version: "1.4.2", binaryDigest: "c".repeat(64),
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
    async http() { return { statusCode: 422, payload: { error: { code: "AGENT_SUPPLY_CHAIN_POLICY_REJECTED", failure: { ...failure, failureCode: "MALWARE_DETECTED" } } } }; },
  });
  await assert.rejects(forged.validateVersion({ ...operation, candidate: candidate! }), /receipt is invalid/);
});

test("production supply-chain configuration accepts only file-mounted mTLS material", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-supply-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = join(root, "client.key");
  const certificate = join(root, "client.crt");
  const ca = join(root, "ca.crt");
  await Promise.all([key, certificate, ca].map((path) => writeFile(path, "x".repeat(64), { mode: 0o400 })));
  const chain = await createAgentSupplyChain({
    NODE_ENV: "production",
    DEVILUDO_AGENT_SUPPLY_CHAIN_URL: "https://agent-supply-chain.internal",
    DEVILUDO_AGENT_SUPPLY_CHAIN_TLS_KEY_FILE: key,
    DEVILUDO_AGENT_SUPPLY_CHAIN_TLS_CERT_FILE: certificate,
    DEVILUDO_AGENT_SUPPLY_CHAIN_CA_FILE: ca,
    DEVILUDO_AGENT_SUPPLY_CHAIN_VERSION: "1.4.2",
    DEVILUDO_AGENT_SUPPLY_CHAIN_BINARY_DIGEST: "d".repeat(64),
  });
  assert.ok(chain instanceof MtlsAgentSupplyChain);
  await assert.rejects(createAgentSupplyChain({ NODE_ENV: "production" }), /TLS_KEY_FILE is required/);
  await assert.rejects(createAgentSupplyChain({
    NODE_ENV: "production",
    DEVILUDO_AGENT_SUPPLY_CHAIN_URL: "https://agent-supply-chain.internal",
    DEVILUDO_AGENT_SUPPLY_CHAIN_TLS_KEY_FILE: "inline-secret",
    DEVILUDO_AGENT_SUPPLY_CHAIN_TLS_CERT_FILE: certificate,
    DEVILUDO_AGENT_SUPPLY_CHAIN_CA_FILE: ca,
    DEVILUDO_AGENT_SUPPLY_CHAIN_VERSION: "1.4.2",
    DEVILUDO_AGENT_SUPPLY_CHAIN_BINARY_DIGEST: "d".repeat(64),
  }), /path is invalid/);
});
