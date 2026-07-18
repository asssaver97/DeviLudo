import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerCapabilities } from "../src/contracts";
import { createRunnerCapabilityDigest } from "../src/coordinator";
import {
  loadMachineConfig,
  PhysicalRunnerDaemon,
  physicalRunnerServiceFromEnv,
  type PhysicalRunnerDiagnosticCode,
} from "../src/run-physical-runner";

const tenantId = "11111111-1111-4111-8111-111111111111";
const sha = (value: string) => value.repeat(64);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function capabilities(platform: RunnerCapabilities["platform"], architecture: RunnerCapabilities["architecture"]): RunnerCapabilities {
  const core = {
    runnerId: `runner-${platform}-1`,
    platform,
    architecture,
    osVersion: `${platform}-pinned-version`,
    runnerImageDigest: sha("1"),
    godotVersion: "4.6.2-stable",
    godotBinaryDigest: sha("2"),
    exportTemplatesDigest: sha("3"),
    gpu: "pinned-gpu",
    display: "virtual" as const,
    audio: "virtual" as const,
    installedAutonomousAgents: [] as readonly string[],
  };
  return { ...core, capabilityDigest: createRunnerCapabilityDigest(core) };
}

function machineConfig(capability: RunnerCapabilities, tenantIds: readonly string[] = [tenantId]) {
  return {
    schemaVersion: "deviludo.physical-runner-config.v1",
    capabilities: capability,
    tenantIds,
  };
}

test("machine config binds each supported Node platform and architecture to its declared Runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-physical-runner-config-"));
  const file = join(root, "runner.json");
  try {
    const cases = [
      { runtime: { platform: "win32" as const, arch: "x64" }, cap: capabilities("windows", "x86_64") },
      { runtime: { platform: "linux" as const, arch: "x64" }, cap: capabilities("linux", "x86_64") },
      { runtime: { platform: "darwin" as const, arch: "arm64" }, cap: capabilities("macos", "arm64") },
    ];
    for (const item of cases) {
      await writeFile(file, JSON.stringify(machineConfig(item.cap)), "utf8");
      const loaded = await loadMachineConfig(file, item.runtime);
      assert.equal(loaded.capabilities.platform, item.cap.platform);
      assert.equal(loaded.capabilities.architecture, item.cap.architecture);
      assert.equal(Object.isFrozen(loaded.capabilities), true);
    }
    await writeFile(file, JSON.stringify(machineConfig(capabilities("linux", "x86_64"))), "utf8");
    await assert.rejects(loadMachineConfig(file, { platform: "darwin", arch: "arm64" }), /does not match/);
    await writeFile(file, JSON.stringify(machineConfig(capabilities("linux", "x86_64"), [tenantId, tenantId])), "utf8");
    await assert.rejects(loadMachineConfig(file, { platform: "linux", arch: "x64" }), /config is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physical Runner daemon serializes cycles, backs off and stops without leaking failure text", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  const diagnostics: PhysicalRunnerDiagnosticCode[] = [];
  let calls = 0;
  const daemon = new PhysicalRunnerDaemon({
    agent: {
      async runOnce() {
        calls += 1;
        if (calls <= 2) throw new Error(`secret-${calls}`);
        if (calls === 3) return { status: "IDLE" as const };
        return {
          status: "COMPLETED" as const,
          tenantId,
          attemptId: "22222222-2222-4222-8222-222222222222",
          platform: "linux" as const,
          result: "PASSED" as const,
          attemptState: "PASSED" as const,
        };
      },
    },
    pollIntervalMs: 1_000,
    maxBackoffMs: 8_000,
    diagnostic: (code) => diagnostics.push(code),
    pause: async (delay) => {
      delays.push(delay);
      if (delays.length === 4) controller.abort();
    },
  });
  await daemon.run(controller.signal);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [1_000, 2_000, 1_000, 250]);
  assert.deepEqual(diagnostics, ["CYCLE_FAILED", "CYCLE_FAILED", "IDLE", "COMPLETED", "STOPPED"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|tenant|attempt/);
});

test("physical Runner production composition loads only file-backed keys and exact machine locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-physical-runner-service-"));
  try {
    const runtime = currentRuntime();
    const cap = capabilities(runtime.target, runtime.architecture);
    const configFile = join(root, "runner.json");
    const tlsKey = join(root, "tls.key");
    const tlsCert = join(root, "tls.crt");
    const ca = join(root, "ca.crt");
    const journalKey = join(root, "journal.key");
    const jobPublicKey = join(root, "jobs.pub");
    const testKitExecutable = join(root, "testkit");
    const godotExecutable = join(root, "godot");
    const testKitBytes = Buffer.from("pinned-testkit-controller-v1");
    const godotBytes = Buffer.from("pinned-godot-binary-v1");
    const keys = generateKeyPairSync("ed25519");
    const lockedCap = {
      ...cap,
      godotBinaryDigest: digest(godotBytes),
    };
    const { capabilityDigest: _oldDigest, ...lockedCore } = lockedCap;
    assert.match(_oldDigest, /^[a-f0-9]{64}$/);
    const finalCap = { ...lockedCore, capabilityDigest: createRunnerCapabilityDigest(lockedCore) };
    await Promise.all([
      writeFile(configFile, JSON.stringify(machineConfig(finalCap)), "utf8"),
      writeFile(tlsKey, Buffer.alloc(64, 1)),
      writeFile(tlsCert, Buffer.alloc(64, 2)),
      writeFile(ca, Buffer.alloc(64, 3)),
      writeFile(journalKey, Buffer.alloc(32, 4)),
      writeFile(jobPublicKey, keys.publicKey.export({ format: "pem", type: "spki" })),
      writeFile(testKitExecutable, testKitBytes),
      writeFile(godotExecutable, godotBytes),
    ]);
    const service = await physicalRunnerServiceFromEnv({
      DEVILUDO_PHYSICAL_RUNNER_CONFIG_FILE: configFile,
      DEVILUDO_RUNNER_JOB_VERIFY_PUBLIC_KEY_FILE: jobPublicKey,
      DEVILUDO_RUNNER_JOB_VERIFY_KEY_ID: "runner-job-key-01",
      DEVILUDO_PHYSICAL_RUNNER_JOURNAL_HMAC_KEY_FILE: journalKey,
      DEVILUDO_PHYSICAL_RUNNER_JOURNAL_ROOT: join(root, "journal"),
      DEVILUDO_PHYSICAL_RUNNER_TESTKIT_EXECUTABLE: testKitExecutable,
      DEVILUDO_PHYSICAL_RUNNER_TESTKIT_DIGEST: digest(testKitBytes),
      DEVILUDO_PHYSICAL_RUNNER_GODOT_EXECUTABLE: godotExecutable,
      DEVILUDO_PHYSICAL_RUNNER_WORK_ROOT: join(root, "work"),
      DEVILUDO_RUNNER_INGRESS_URL: "https://runner-control.internal",
      DEVILUDO_PHYSICAL_RUNNER_TLS_KEY_FILE: tlsKey,
      DEVILUDO_PHYSICAL_RUNNER_TLS_CERT_FILE: tlsCert,
      DEVILUDO_PHYSICAL_RUNNER_CA_FILE: ca,
      DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL: "https://evidence-archive.internal",
      DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE: tlsKey,
      DEVILUDO_TESTKIT_ARTIFACT_TLS_CERT_FILE: tlsCert,
      DEVILUDO_TESTKIT_ARTIFACT_CA_FILE: ca,
      DEVILUDO_TESTKIT_TRANSFER_CA_FILE: ca,
      DEVILUDO_TESTKIT_ALLOWED_TRANSFER_ORIGINS_JSON: '["https://s3.internal"]',
    }, { platform: process.platform, arch: process.arch });
    assert.equal(service.config.capabilities.capabilityDigest, finalCap.capabilityDigest);
    assert.equal(service.jobPublicKey.asymmetricKeyType, "ed25519");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function currentRuntime(): {
  target: RunnerCapabilities["platform"];
  architecture: RunnerCapabilities["architecture"];
} {
  const target = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  return { target, architecture };
}
