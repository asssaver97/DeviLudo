import assert from "node:assert/strict";
import test from "node:test";
import { RunnerCapacityController, type FleetCapacityIntent, type FleetCapacityStore } from "../src/capacity-controller";
import { parseMacCapacityEvent } from "../src/capacity-events";
import { signAwsJsonRequest } from "../src/aws-sqs-capacity";
import { evaluateP0RuntimeReadiness } from "../src/p0-readiness-http";

test("capacity controller records only changed targets and publishes Mac exactly once", async () => {
  const intents: FleetCapacityIntent[] = [];
  const published: string[] = [];
  const store: FleetCapacityStore = {
    async loadDemand() { return {
      queued: { AGENT: 0, LINUX: 0, WINDOWS: 0, MACOS: 1 },
      running: { AGENT: 0, LINUX: 0, WINDOWS: 0, MACOS: 0 },
      onlineHosts: { AGENT: 1, LINUX: 1, WINDOWS: 1, MACOS: 0 },
      gpuQueued: { linux: 0, windows: 0 }, macReleaseEligible: true,
    }; },
    async latestDesiredHosts() { return { AGENT: 1, LINUX: 1, WINDOWS: 1, MACOS: 0 }; },
    async createIntent(decision, at) {
      const intent = { ...decision, id: "00000000-0000-4000-8000-000000000001", state: "REQUESTED" as const, requestedAt: at.toISOString() };
      intents.push(intent); return intent;
    },
    async markPublished(intent, receipt) { assert.equal(receipt.provider, "AWS"); published.push(intent.id); },
  };
  const controller = new RunnerCapacityController({ store, macPublisher: { async publish(intent) {
    assert.equal(intent.fleet, "MACOS"); return { provider: "AWS", messageId: "message-1" };
  } } });
  const result = await controller.reconcile(new Date("2030-01-01T00:00:00.000Z"));
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0]?.fleet, "MACOS");
  assert.deepEqual(published, ["00000000-0000-4000-8000-000000000001"]);
});

test("capacity controller does not create orphan intents for persistent OpenTofu fleets", async () => {
  const created: string[] = [];
  const store: FleetCapacityStore = {
    async loadDemand() { return {
      queued: { AGENT: 0, LINUX: 0, WINDOWS: 0, MACOS: 0 }, running: { AGENT: 0, LINUX: 0, WINDOWS: 0, MACOS: 0 },
      onlineHosts: { AGENT: 1, LINUX: 1, WINDOWS: 1, MACOS: 0 }, gpuQueued: { linux: 0, windows: 0 }, macReleaseEligible: true,
    }; },
    async latestDesiredHosts() { return { AGENT: null, LINUX: null, WINDOWS: null, MACOS: 0 }; },
    async createIntent(decision, at) { created.push(decision.fleet); return { ...decision, id: "00000000-0000-4000-8000-000000000001", state: "REQUESTED", requestedAt: at.toISOString() }; },
    async markPublished() { throw new Error("should not publish"); },
  };
  const controller = new RunnerCapacityController({ store, macPublisher: { async publish() { throw new Error("should not publish"); } } });
  const result = await controller.reconcile(new Date("2030-01-01T00:00:00.000Z"));
  assert.deepEqual(created, []);
  assert.deepEqual(result.created, []);
});

test("AWS Mac result events require the actual 24-hour allocation binding", () => {
  const value = {
    intent: { schemaVersion: "deviludo.macos-capacity-intent.v1", intentId: "00000000-0000-4000-8000-000000000001",
      operationKey: `capacity:${"a".repeat(64)}`, desiredHosts: 1, requestedAt: "2030-01-01T00:00:00.000Z",
      minimumReleaseAt: "2030-01-02T00:00:00.000Z" },
    state: "REGISTERED", hostId: "h-0123456789abcdef0", instanceId: "i-0123456789abcdef0", runnerId: "runner:macos:1",
    allocatedAt: "2030-01-01T00:00:00.000Z", minimumReleaseAt: "2030-01-02T00:00:00.000Z",
    registered: true, exhausted: false, checks: 1,
  };
  assert.equal(parseMacCapacityEvent(JSON.stringify(value)).state, "REGISTERED");
  assert.throws(() => parseMacCapacityEvent(JSON.stringify({ ...value, minimumReleaseAt: "2030-01-01T23:59:59.999Z" })), /invalid/);
  assert.throws(() => parseMacCapacityEvent(JSON.stringify({ ...value, runnerId: null })), /invalid/);
  assert.throws(() => parseMacCapacityEvent(JSON.stringify({ ...value, secret: "must-not-be-persisted" })), /invalid/);
  const idempotentRollback = parseMacCapacityEvent(JSON.stringify({ intent: value.intent, state: "RELEASED", idempotent: true, rollback: true }));
  assert.equal(idempotentRollback.rollback, true);
});

test("AWS SQS signing binds temporary credentials without placing their secret in headers", () => {
  const headers = signAwsJsonRequest({
    method: "POST", url: new URL("https://sqs.ap-southeast-1.amazonaws.com/"), region: "ap-southeast-1",
    service: "sqs", body: "{}", target: "AmazonSQS.SendMessage", at: new Date("2030-01-01T00:00:00.000Z"),
    credentials: { accessKeyId: "ASIAEXAMPLE123456", secretAccessKey: "s".repeat(40), sessionToken: "t".repeat(64), expiration: "2030-01-01T01:00:00.000Z" },
  });
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE123456\/20300101\/ap-southeast-1\/sqs\/aws4_request/);
  assert.equal(headers["x-amz-security-token"], "t".repeat(64));
  assert.doesNotMatch(JSON.stringify(headers), /s{32}/);
});

test("P0 runtime readiness requires the exact Provider, Agent, fleet, evidence, Vault and migration gates", async () => {
  const hosts: Record<string, Record<string, unknown>> = {
    "profile.deviludo.svc.cluster.local": { schemaVersion: "deviludo.agent-profile-readiness.v1", status: "ready", agent: "claude-code",
      cliVersion: "2.1.201", model: "claude-opus-4-1-20250805", profileState: "READY", providerState: "READY",
      credentialState: "ACTIVE", installationState: "ACTIVE", workerState: "READY" },
    "runners.deviludo.svc.cluster.local": { schemaVersion: "deviludo.runner-fleet-readiness.v1", status: "ready", linux: "ONLINE", windows: "ONLINE", macCapacity: "ON_DEMAND_READY" },
    "inference.deviludo.svc.cluster.local": { status: "ok", service: "deviludo-inference-gateway", connector: "CONFIGURED", providerProbe: "CONFIGURED" },
    "evidence.deviludo.svc.cluster.local": { status: "ok", service: "deviludo-evidence-archive" },
    "secrets.deviludo.svc.cluster.local": { status: "ok", service: "deviludo-secret-broker" },
    "migrations.deviludo.svc.cluster.local": { schemaVersion: "deviludo.migration-readiness.v1", status: "ready", pending: 0 },
  };
  const env = Object.fromEntries(Object.keys(hosts).map((host, index) => [[
    "DEVILUDO_AGENT_PROFILE_READINESS_URL", "DEVILUDO_RUNNER_FLEET_READINESS_URL",
    "DEVILUDO_INFERENCE_GATEWAY_URL", "DEVILUDO_EVIDENCE_ARCHIVE_URL", "DEVILUDO_SECRET_BROKER_URL", "DEVILUDO_MIGRATION_READINESS_URL",
  ][index], `http://${host}/`]));
  const fetcher = async (input: string | URL | Request) => Response.json(hosts[new URL(String(input)).hostname]);
  const ready = await evaluateP0RuntimeReadiness(env, { fetch: fetcher as typeof fetch });
  assert.equal(ready.status, "ready");
  assert.equal(ready.claudeModel, "claude-opus-4-1-20250805");
  hosts["profile.deviludo.svc.cluster.local"]!.model = "sonnet";
  const blocked = await evaluateP0RuntimeReadiness(env, { fetch: fetcher as typeof fetch });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.claudeModel, "BLOCKED");
});
