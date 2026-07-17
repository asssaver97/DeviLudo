import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { RunnerEvent } from "../../../lib/domain/e2e";
import type { TargetPlatform } from "../../../lib/domain/types";
import { sha256Canonical, signCanonical } from "../src/canonical";
import type {
  PlatformEvidenceManifest,
  RegisteredRunner,
  RunnerCapabilities,
  RunnerEventReceipt,
  RunnerJobPayload,
  SignedRunnerJob,
} from "../src/contracts";
import { createRunnerCapabilityDigest, REQUIRED_RUNNER_EVIDENCE } from "../src/coordinator";
import {
  MemoryPhysicalRunnerJournal,
  PhysicalRunnerAgent,
  type PhysicalRunnerIngress,
  type PhysicalRunnerJournal,
  type PhysicalRunnerJournalRecord,
} from "../src/physical-runner";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenantId = "22222222-2222-4222-8222-222222222222";
const now = "2030-01-01T00:00:00.000Z";
const sha = (value: string) => value.repeat(64);
const keys = generateKeyPairSync("ed25519");

function capabilities(platform: TargetPlatform): RunnerCapabilities {
  const core = {
    runnerId: `runner-${platform}-1`,
    platform,
    architecture: platform === "macos" ? "arm64" as const : "x86_64" as const,
    osVersion: `${platform}-version-pinned`,
    runnerImageDigest: sha("1"),
    godotVersion: "4.6.2-stable",
    godotBinaryDigest: sha("2"),
    exportTemplatesDigest: sha(platform === "windows" ? "3" : platform === "linux" ? "4" : "5"),
    gpu: "contract-gpu",
    display: "virtual" as const,
    audio: "virtual" as const,
    installedAutonomousAgents: [] as readonly string[],
  };
  return { ...core, capabilityDigest: createRunnerCapabilityDigest(core) };
}

function job(platform: TargetPlatform, overrides: Partial<RunnerJobPayload> = {}): SignedRunnerJob {
  const cap = capabilities(platform);
  const payload: RunnerJobPayload = {
    schemaVersion: "deviludo.runner-job.v2",
    attemptId: platform === "windows"
      ? "33333333-3333-4333-8333-333333333331"
      : platform === "linux"
        ? "33333333-3333-4333-8333-333333333332"
        : "33333333-3333-4333-8333-333333333333",
    tenantId,
    projectId: "44444444-4444-4444-8444-444444444444",
    runId: "55555555-5555-4555-8555-555555555555",
    iterationId: "66666666-6666-4666-8666-666666666666",
    runnerId: cap.runnerId,
    platform,
    fencingToken: 9,
    leaseExpiresAt: "2030-01-01T00:05:00.000Z",
    executionLockId: "77777777-7777-4777-8777-777777777777",
    executionLockDigest: sha("6"),
    commitSha: "a".repeat(40),
    sourceDigest: sha("7"),
    execution: {
      kind: "SOURCE_ARTIFACT",
      objectKey: `tenants/${tenantId}/source/game.tar.zst`,
      artifactDigest: sha("8"),
    },
    specRevisionId: "88888888-8888-4888-8888-888888888888",
    specDigest: sha("9"),
    testPlanDigest: sha("a"),
    targetMatrix: ["linux", "macos", "windows"],
    requiredGodotVersion: cap.godotVersion,
    godotTestKitDigest: sha("b"),
    exportTemplatesDigest: cap.exportTemplatesDigest,
    runnerCapabilityDigest: cap.capabilityDigest,
    buildManifestDigest: sha("c"),
    sbomDigest: sha("d"),
    vulnerabilityScanDigest: sha("e"),
    assetLicenseLedgerDigest: sha("f"),
    requiredEvidence: REQUIRED_RUNNER_EVIDENCE,
    ...overrides,
  };
  return {
    payload,
    signature: {
      algorithm: "Ed25519",
      keyId: "runner-job-key-01",
      value: signCanonical(keys.privateKey, payload),
    },
  };
}

class ContractIngress implements PhysicalRunnerIngress {
  readonly events = new Map<number, RunnerEvent>();
  evidence: PlatformEvidenceManifest | null = null;
  eventCalls = 0;

  constructor(readonly capabilities: RunnerCapabilities, readonly signedJob: SignedRunnerJob) {}

  async register(): Promise<RegisteredRunner> {
    return {
      ...this.capabilities,
      spiffeId: `spiffe://deviludo.test/e2e/${this.capabilities.runnerId}`,
      certificateFingerprint: sha("0"),
      certificateSerial: "01",
      certificateNotAfter: "2031-01-01T00:00:00.000Z",
      state: "ONLINE",
      registeredAt: now,
      lastSeenAt: now,
    };
  }

  async leaseNext(runnerId: string, requestedTenantId: string): Promise<SignedRunnerJob | null> {
    assert.equal(runnerId, this.capabilities.runnerId);
    assert.equal(requestedTenantId, tenantId);
    return this.signedJob;
  }

  async submitEvidence(requestedTenantId: string, manifest: PlatformEvidenceManifest): Promise<PlatformEvidenceManifest> {
    assert.equal(requestedTenantId, tenantId);
    if (this.evidence) assert.equal(sha256Canonical(this.evidence), sha256Canonical(manifest));
    else this.evidence = manifest;
    return manifest;
  }

  async acceptEvent(requestedTenantId: string, event: RunnerEvent): Promise<RunnerEventReceipt> {
    assert.equal(requestedTenantId, tenantId);
    this.eventCalls += 1;
    const existing = this.events.get(event.seqNo);
    if (existing) assert.equal(sha256Canonical(existing), sha256Canonical(event));
    else {
      assert.equal(event.seqNo, this.events.size + 1);
      this.events.set(event.seqNo, event);
    }
    const terminal = event.type === "PLATFORM_COMPLETED";
    return {
      accepted: true,
      attemptState: terminal ? event.status : "RUNNING",
      cursor: {
        lastAcceptedSeqNo: event.seqNo,
        completedPlatforms: terminal ? { [event.platform]: event.status } : {},
        terminal,
      },
      event,
      evidenceBundle: null,
    };
  }
}

function output() {
  return {
    exportDigest: sha("1"),
    logsDigest: sha("2"),
    junitDigest: sha("3"),
    inputTimelineDigest: sha("4"),
    screenshotManifestDigest: sha("5"),
    videoManifestDigest: sha("6"),
    status: "PASSED" as const,
    createdAt: "2030-01-01T00:00:01.000Z",
  };
}

for (const platform of ["windows", "linux", "macos"] as const) {
  test(`physical ${platform} Runner verifies and completes the same immutable protocol`, async () => {
    const cap = capabilities(platform);
    const ingress = new ContractIngress(cap, job(platform));
    let executions = 0;
    const agent = new PhysicalRunnerAgent({
      capabilities: cap,
      tenantIds: [tenantId],
      jobKeyId: "runner-job-key-01",
      jobPublicKey: keys.publicKey,
      ingress,
      executor: { async execute() { executions += 1; return output(); } },
      journal: new MemoryPhysicalRunnerJournal(),
      now: () => new Date(now),
    });

    const result = await agent.runOnce();
    assert.deepEqual(result, {
      status: "COMPLETED",
      tenantId,
      attemptId: job(platform).payload.attemptId,
      platform,
      result: "PASSED",
      attemptState: "PASSED",
    });
    assert.equal(executions, 1);
    assert.equal(ingress.events.size, 2);
    assert.equal(ingress.evidence?.runnerCapabilityDigest, cap.capabilityDigest);
  });
}

test("physical Runner journal replays identical events and evidence without re-executing TestKit", async () => {
  const cap = capabilities("linux");
  const ingress = new ContractIngress(cap, job("linux"));
  const journal = new MemoryPhysicalRunnerJournal();
  let executions = 0;
  const agent = new PhysicalRunnerAgent({
    capabilities: cap,
    tenantIds: [tenantId],
    jobKeyId: "runner-job-key-01",
    jobPublicKey: keys.publicKey,
    ingress,
    executor: { async execute() { executions += 1; return output(); } },
    journal,
    now: () => new Date(now),
  });
  await agent.runOnce();
  await agent.runOnce();
  assert.equal(executions, 1);
  assert.equal(ingress.events.size, 2);
  assert.equal(ingress.eventCalls, 4);
});

test("physical Runner rejects signature tampering, cross-tenant jobs and capability drift before execution", async () => {
  const cap = capabilities("linux");
  const valid = job("linux");
  const cases: SignedRunnerJob[] = [
    { ...valid, payload: { ...valid.payload, sourceDigest: sha("0") } },
    job("linux", { tenantId: otherTenantId }),
    job("linux", { runnerCapabilityDigest: sha("0") }),
  ];
  for (const signedJob of cases) {
    let executions = 0;
    const ingress = new ContractIngress(cap, signedJob);
    const agent = new PhysicalRunnerAgent({
      capabilities: cap,
      tenantIds: [tenantId],
      jobKeyId: "runner-job-key-01",
      jobPublicKey: keys.publicKey,
      ingress,
      executor: { async execute() { executions += 1; return output(); } },
      journal: new MemoryPhysicalRunnerJournal(),
      now: () => new Date(now),
    });
    await assert.rejects(agent.runOnce(), /invalid|does not match/);
    assert.equal(executions, 0);
    assert.equal(ingress.events.size, 0);
  }
});

test("physical Runner rejects locally persisted journal evidence tampering before replay", async () => {
  const cap = capabilities("linux");
  const ingress = new ContractIngress(cap, job("linux"));
  class CapturingJournal implements PhysicalRunnerJournal {
    record: PhysicalRunnerJournalRecord | null = null;
    async load() { return this.record; }
    async save(record: PhysicalRunnerJournalRecord) { this.record = record; }
  }
  const journal = new CapturingJournal();
  let executions = 0;
  const agent = new PhysicalRunnerAgent({
    capabilities: cap,
    tenantIds: [tenantId],
    jobKeyId: "runner-job-key-01",
    jobPublicKey: keys.publicKey,
    ingress,
    executor: { async execute() { executions += 1; return output(); } },
    journal,
    now: () => new Date(now),
  });
  await agent.runOnce();
  assert.ok(journal.record?.evidenceManifest);
  journal.record = {
    ...journal.record,
    evidenceManifest: { ...journal.record.evidenceManifest, sourceDigest: sha("0") },
  };
  await assert.rejects(agent.runOnce(), /journal evidence conflicts/);
  assert.equal(executions, 1);
});
