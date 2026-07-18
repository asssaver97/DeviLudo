import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DevelopmentAgentSupplyChain } from "../../control-plane/src/agent-supply-chain";
import { sha256Canonical } from "../../runner-control/src/canonical";
import { AgentSupplyChainTerminalError, DurableAgentSupplyChainBrokerService } from "../src/broker-service";
import type {
  AgentSupplyChainNativeExecutor,
  AgentSupplyChainRequest,
  AgentSupplyChainTerminalFailureReceipt,
} from "../src/contracts";
import { createAgentSupplyChainHandler, createAgentSupplyChainHttpsServer } from "../src/ingress-http";
import { LockedNativeAgentSupplyChainExecutor } from "../src/locked-native-executor";
import { InMemoryAgentSupplyChainOperations } from "../src/operation-memory";
import { agentSupplyChainServiceConfigFromEnv } from "../src/run-service";

const operationKey = "a".repeat(64);
const requestDigest = "b".repeat(64);
const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/control-plane",
  certificateFingerprint: "c".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2026-07-18T09:00:00.000Z",
});

class FixtureNativeExecutor implements AgentSupplyChainNativeExecutor {
  readonly implementation = new DevelopmentAgentSupplyChain(() => new Date("2026-07-18T08:00:00.000Z"));
  executions = 0;
  async probe() {}
  async execute(request: AgentSupplyChainRequest) {
    this.executions += 1;
    switch (request.schemaVersion) {
      case "deviludo.agent-version-discovery-request.v1":
        return Object.freeze({
          schemaVersion: "deviludo.agent-version-discovery-receipt.v1" as const,
          candidates: await this.implementation.discover(request),
        });
      case "deviludo.agent-version-validation-request.v1":
        return this.implementation.validateVersion(request);
      case "deviludo.agent-installation-build-request.v1":
        return this.implementation.buildInstallation(request);
      case "deviludo.agent-installation-rollout-request.v1":
        return this.implementation.rollout(request);
    }
  }
}

test("mTLS Broker executes and durably replays the complete Agent supply-chain lifecycle", async () => {
  const operations = new InMemoryAgentSupplyChainOperations();
  const executor = new FixtureNativeExecutor();
  let tick = 0;
  const service = new DurableAgentSupplyChainBrokerService(operations, executor, {
    claimToken: () => `${String(++tick).padStart(8, "0")}-0000-4000-8000-000000000000`,
    now: () => new Date("2026-07-18T08:00:00.000Z"),
  });
  const handler = createAgentSupplyChainHandler({
    service,
    allowedSpiffeIds: new Set([identity.spiffeId]),
    healthIdentity: { version: "1.0.0", binaryDigest: "d".repeat(64) },
    now: () => new Date("2026-07-18T08:00:00.000Z"),
    extractIdentity: () => identity,
  });

  const discovery = await post(handler, "/v1/agent-versions/discover", {
    schemaVersion: "deviludo.agent-version-discovery-request.v1",
    operationKey,
    requestDigest,
    agent: "claude-code",
    requestedVersion: "2.1.15",
  });
  assert.equal(discovery.status, 200);
  const candidate = (discovery.body as { candidates: unknown[] }).candidates[0];

  const replay = await post(handler, "/v1/agent-versions/discover", {
    schemaVersion: "deviludo.agent-version-discovery-request.v1",
    operationKey,
    requestDigest,
    agent: "claude-code",
    requestedVersion: "2.1.15",
  });
  assert.deepEqual(replay.body, discovery.body);
  assert.equal(executor.executions, 1);

  const validation = await post(handler, "/v1/agent-versions/validate", {
    schemaVersion: "deviludo.agent-version-validation-request.v1",
    operationKey: "e".repeat(64),
    requestDigest: "f".repeat(64),
    candidate,
  });
  assert.equal(validation.status, 200);

  const build = await post(handler, "/v1/agent-installations/build", {
    schemaVersion: "deviludo.agent-installation-build-request.v1",
    operationKey: "1".repeat(64),
    requestDigest: "2".repeat(64),
    installationId: "claude-code-installation-fixed",
    candidate,
    validation: validation.body,
    workerPool: "development-linux-canary",
    adapterVersion: "1.3.0",
    rollbackInstallationId: null,
  });
  assert.equal(build.status, 200);
  assert.match((build.body as { imageDigest: string }).imageDigest, /^sha256:[a-f0-9]{64}$/);

  const rollout = await post(handler, "/v1/agent-installations/rollout", {
    schemaVersion: "deviludo.agent-installation-rollout-request.v1",
    operationKey: "3".repeat(64),
    requestDigest: "4".repeat(64),
    installationId: "claude-code-installation-fixed",
    imageDigest: (build.body as { imageDigest: string }).imageDigest,
    action: "ADVANCE",
    fromPercent: 0,
    toPercent: 5,
  });
  assert.equal(rollout.status, 200);
  assert.equal((rollout.body as { newTasksOnly: boolean }).newTasksOnly, true);
  assert.equal(executor.executions, 4);
  assert.equal(operations.entries.size, 4);
});

test("Broker ingress requires its exact workload, route and request schema", async () => {
  const service = new DurableAgentSupplyChainBrokerService(new InMemoryAgentSupplyChainOperations(), new FixtureNativeExecutor());
  const forbidden = createAgentSupplyChainHandler({
    service,
    allowedSpiffeIds: new Set(["spiffe://deviludo.internal/control-plane"]),
    healthIdentity: { version: "1.0.0", binaryDigest: "d".repeat(64) },
    extractIdentity: () => ({ ...identity, spiffeId: "spiffe://deviludo.internal/runner" }),
  });
  assert.equal((await post(forbidden, "/v1/agent-versions/discover", {})).status, 403);

  const handler = createAgentSupplyChainHandler({
    service,
    allowedSpiffeIds: new Set([identity.spiffeId]),
    healthIdentity: { version: "1.0.0", binaryDigest: "d".repeat(64) },
    extractIdentity: () => identity,
  });
  const extra = await post(handler, "/v1/agent-versions/discover", {
    schemaVersion: "deviludo.agent-version-discovery-request.v1",
    operationKey,
    requestDigest,
    agent: "claude-code",
    requestedVersion: "2.1.15",
    packageUrl: "https://attacker.invalid/package.tgz",
  });
  assert.equal(extra.status, 400);
  assert.equal((extra.body as { error: { code: string } }).error.code, "AGENT_SUPPLY_CHAIN_REQUEST_INVALID");

  const wrongRoute = await post(handler, "/v1/agent-installations/build", {
    schemaVersion: "deviludo.agent-version-discovery-request.v1",
    operationKey,
    requestDigest,
    agent: "claude-code",
    requestedVersion: "2.1.15",
  });
  assert.equal(wrongRoute.status, 400);

  const [official] = await new DevelopmentAgentSupplyChain(() => new Date("2026-07-18T08:00:00.000Z")).discover({
    operationKey,
    requestDigest,
    agent: "claude-code",
    requestedVersion: "2.1.15",
  });
  assert.ok(official);
  const forgedCore = {
    agent: official.agent,
    version: official.version,
    source: "https://attacker.invalid/claude-code-2.1.15.tgz",
    sourceDigest: official.sourceDigest,
    releaseNotesUrl: official.releaseNotesUrl,
    catalogReceiptId: official.catalogReceiptId,
    discoveredAt: official.discoveredAt,
  };
  const forgedCandidate = { ...forgedCore, catalogReceiptDigest: sha256Canonical(forgedCore) };
  const forgedSource = await post(handler, "/v1/agent-versions/validate", {
    schemaVersion: "deviludo.agent-version-validation-request.v1",
    operationKey: "5".repeat(64),
    requestDigest: "6".repeat(64),
    candidate: forgedCandidate,
  });
  assert.equal(forgedSource.status, 400);
  assert.throws(() => createAgentSupplyChainHttpsServer({ tls: {}, handler }), /configuration is invalid/);
});

test("Broker releases a failed native claim and retries the same immutable operation", async () => {
  const operations = new InMemoryAgentSupplyChainOperations();
  const fixture = new FixtureNativeExecutor();
  let attempts = 0;
  let token = 0;
  const service = new DurableAgentSupplyChainBrokerService(operations, {
    async probe() {},
    async execute(request) {
      attempts += 1;
      if (attempts === 1) throw new Error("transient native failure");
      return fixture.execute(request);
    },
  }, {
    claimToken: () => `${String(++token).padStart(8, "0")}-0000-4000-8000-000000000000`,
    now: () => new Date("2026-07-18T08:00:00.000Z"),
  });
  const request = {
    schemaVersion: "deviludo.agent-version-discovery-request.v1" as const,
    operationKey,
    requestDigest,
    agent: "claude-code" as const,
    requestedVersion: "2.1.15",
  };
  await assert.rejects(service.execute(request), /transient native failure/);
  assert.equal(operations.entries.get(operationKey)?.state, "PENDING");
  const response = await service.execute(request);
  assert.equal((response as { candidates: readonly unknown[] }).candidates.length, 1);
  assert.equal(operations.entries.get(operationKey)?.state, "COMPLETED");
});

test("Broker durably replays a sanitized terminal policy failure without rerunning native code", async () => {
  const operations = new InMemoryAgentSupplyChainOperations();
  const fixture = new FixtureNativeExecutor();
  const [candidate] = await fixture.implementation.discover({
    operationKey, requestDigest, agent: "claude-code", requestedVersion: "2.1.15",
  });
  const request = {
    schemaVersion: "deviludo.agent-version-validation-request.v1" as const,
    operationKey: "7".repeat(64),
    requestDigest: "8".repeat(64),
    candidate: candidate!,
  };
  const terminal = terminalFailure(request, "SIGNATURE_INVALID");
  let executions = 0;
  let tokens = 0;
  const service = new DurableAgentSupplyChainBrokerService(operations, {
    async probe() {},
    async execute() { executions += 1; throw new AgentSupplyChainTerminalError(terminal); },
  }, {
    claimToken: () => `${String(++tokens).padStart(8, "0")}-0000-4000-8000-000000000000`,
    now: () => new Date("2026-07-18T08:00:00.000Z"),
  });
  const handler = createAgentSupplyChainHandler({
    service,
    allowedSpiffeIds: new Set([identity.spiffeId]),
    healthIdentity: { version: "1.0.0", binaryDigest: "d".repeat(64) },
    extractIdentity: () => identity,
  });
  const first = await post(handler, "/v1/agent-versions/validate", request);
  const replay = await post(handler, "/v1/agent-versions/validate", request);
  assert.equal(first.status, 422);
  assert.deepEqual(replay, first);
  assert.deepEqual((first.body as { error: { failure: unknown } }).error.failure, terminal);
  assert.equal(executions, 1);
  assert.equal(operations.entries.get(request.operationKey)?.state, "COMPLETED");
});

test("locked native executor pins artifacts, argv, child environment and immutable replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-supply-chain-"));
  const executable = join(root, "native-agent-supply-chain");
  const config = join(root, "policy.json");
  const workRoot = join(root, "work");
  await Promise.all([writeFile(executable, "signed-native-fixture"), writeFile(config, "fixed-policy-fixture"), mkdir(workRoot)]);
  await chmod(executable, 0o500);
  const executableDigest = digest(await readFile(executable));
  const configDigest = digest(await readFile(config));
  const fixture = new FixtureNativeExecutor();
  const discoveryRequest = {
    schemaVersion: "deviludo.agent-version-discovery-request.v1" as const,
    operationKey,
    requestDigest,
    agent: "claude-code" as const,
    requestedVersion: "2.1.15",
  };
  const expectedResponse = await fixture.execute(discoveryRequest);
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const executor = new LockedNativeAgentSupplyChainExecutor({
    executable,
    executableDigest,
    configFile: config,
    configDigest,
    workRoot,
    process: async (_file, args, options) => {
      calls.push({ args, env: options.env });
      if (args[0] === "probe") return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: "deviludo.native-agent-supply-chain-probe.v1", status: "READY", configDigest }), stderr: "" };
      const responsePath = args[args.indexOf("--response-file") + 1];
      assert.ok(responsePath);
      await writeFile(responsePath, JSON.stringify(expectedResponse), { mode: 0o400 });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await executor.probe();
  const first = await executor.execute(discoveryRequest);
  const replay = await executor.execute(discoveryRequest);
  assert.deepEqual(replay, first);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.args.slice(0, 3), ["discover-version", "--config-file", config]);
  assert.deepEqual(Object.keys(calls[1]?.env ?? {}).sort(), ["DISABLE_UPDATES", "HOME", "LANG", "NODE_ENV", "TEMP", "TMP", "TMPDIR", "USERPROFILE"].sort());
  assert.equal(JSON.stringify(calls).includes("apiKey"), false);
});

test("locked native executor accepts terminal failures only on the dedicated exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-supply-chain-terminal-"));
  const executable = join(root, "native-agent-supply-chain");
  const config = join(root, "policy.json");
  const workRoot = join(root, "work");
  await Promise.all([writeFile(executable, "signed-native-fixture"), writeFile(config, "fixed-policy-fixture"), mkdir(workRoot)]);
  await chmod(executable, 0o500);
  const fixture = new FixtureNativeExecutor();
  const [candidate] = await fixture.implementation.discover({
    operationKey, requestDigest, agent: "codex-cli", requestedVersion: "0.92.0",
  });
  const request = {
    schemaVersion: "deviludo.agent-version-validation-request.v1" as const,
    operationKey: "9".repeat(64), requestDigest: "a".repeat(64), candidate: candidate!,
  };
  const terminal = terminalFailure(request, "MALWARE_DETECTED");
  const executor = new LockedNativeAgentSupplyChainExecutor({
    executable,
    executableDigest: digest(await readFile(executable)),
    configFile: config,
    configDigest: digest(await readFile(config)),
    workRoot,
    process: async (_file, args) => {
      const responsePath = args[args.indexOf("--response-file") + 1];
      assert.ok(responsePath);
      await writeFile(responsePath, JSON.stringify(terminal), { mode: 0o400 });
      return { exitCode: 42, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(executor.execute(request), (error) => {
    assert.ok(error instanceof AgentSupplyChainTerminalError);
    assert.deepEqual(error.receipt, terminal);
    return true;
  });
});

test("production service config accepts only file-mounted mTLS and pinned native artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-supply-chain-config-"));
  const files = Object.fromEntries(await Promise.all(["key", "cert", "ca"].map(async (name) => {
    const path = join(root, name);
    await writeFile(path, name.repeat(32));
    return [name, path];
  })));
  const env = {
    NODE_ENV: "production",
    DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_TLS_KEY_FILE: files.key,
    DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_TLS_CERT_FILE: files.cert,
    DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_CLIENT_CA_FILE: files.ca,
    DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_VERSION: "1.0.0",
    DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_BINARY_DIGEST: "a".repeat(64),
    DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_ALLOWED_SPIFFE_IDS: '["spiffe://deviludo.internal/control-plane"]',
    DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_EXECUTABLE: join(root, "native"),
    DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_EXECUTABLE_DIGEST: "b".repeat(64),
    DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_CONFIG_FILE: join(root, "policy.json"),
    DEVILUDO_AGENT_SUPPLY_CHAIN_NATIVE_CONFIG_DIGEST: "c".repeat(64),
    DEVILUDO_AGENT_SUPPLY_CHAIN_WORK_ROOT: join(root, "work"),
  };
  const config = await agentSupplyChainServiceConfigFromEnv(env);
  assert.equal(config.port, 4755);
  assert.equal(config.allowedSpiffeIds.has("spiffe://deviludo.internal/control-plane"), true);
  await assert.rejects(agentSupplyChainServiceConfigFromEnv({ ...env, DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_VERSION: "latest" }), /version is invalid/);
  await assert.rejects(agentSupplyChainServiceConfigFromEnv({ ...env, DEVILUDO_AGENT_SUPPLY_CHAIN_SERVER_TLS_KEY_FILE: undefined }), /TLS_KEY_FILE is required/);
});

async function post(
  handler: ReturnType<typeof createAgentSupplyChainHandler>,
  path: string,
  body: unknown,
) {
  return handler({
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    socket: {},
    rawBody: JSON.stringify(body),
  });
}

function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function terminalFailure(
  request: Extract<AgentSupplyChainRequest, { schemaVersion: "deviludo.agent-version-validation-request.v1" }>,
  failureCode: AgentSupplyChainTerminalFailureReceipt["failureCode"],
): AgentSupplyChainTerminalFailureReceipt {
  const core = Object.freeze({
    schemaVersion: "deviludo.agent-supply-chain-terminal-failure.v1" as const,
    operationKey: request.operationKey,
    requestDigest: request.requestDigest,
    operationKind: "VALIDATE" as const,
    disposition: "REJECTED" as const,
    failureCode,
    evidenceDigest: "e".repeat(64),
    failureReceiptId: `failure-${request.operationKey.slice(0, 16)}`,
    failedAt: "2026-07-18T08:00:00.000Z",
  });
  return Object.freeze({ ...core, failureReceiptDigest: sha256Canonical(core) });
}
