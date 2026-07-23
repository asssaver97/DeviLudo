import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signCanonical } from "../../runner-control/src/canonical";
import {
  compileFirecrackerConfiguration,
  compileJailerArguments,
  parseNativeMicrovmLauncherArguments,
  parseNativeMicrovmLauncherConfig,
} from "../src/native-microvm-launcher";
import {
  agentMicrovmLauncherTrustPolicyDigest,
  validateAgentMicrovmLauncherTrustPolicy,
  verifySignedAgentMicrovmLauncherRelease,
} from "../src/native-microvm-launcher-release";
import { verifyAgentMicrovmLauncherRuntimeFromEnv } from "../src/run-native-worker";

const keys = generateKeyPairSync("ed25519");
const keyId = "agent-microvm-launcher-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.agent-microvm-launcher-trust-policy.v1",
  policyId: "deviludo-agent-microvm-production",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const trustPolicyDigest = agentMicrovmLauncherTrustPolicyDigest(trustPolicy);

function config(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "deviludo.agent-microvm-launcher-config.v1",
    backend: "firecracker-jailer",
    platformVersion: "0.1.0-beta.1",
    firecrackerVersion: "1.13.1",
    firecrackerExecutable: "/opt/deviludo/firecracker/firecracker",
    firecrackerDigest: "1".repeat(64),
    jailerExecutable: "/opt/deviludo/firecracker/jailer",
    jailerDigest: "2".repeat(64),
    kernelImage: "/opt/deviludo/microvm/vmlinux",
    kernelDigest: "3".repeat(64),
    rootfsImage: "/opt/deviludo/microvm/agent-guest.ext4",
    rootfsDigest: "4".repeat(64),
    mke2fsExecutable: "/usr/sbin/mke2fs",
    mke2fsDigest: "5".repeat(64),
    debugfsExecutable: "/usr/sbin/debugfs",
    debugfsDigest: "6".repeat(64),
    chrootBaseDirectory: "/var/lib/deviludo/firecracker-jails",
    networkNamespaceDirectory: "/run/netns",
    networkNamespaceNames: ["deviludo-agent-001", "deviludo-agent-002"],
    networkLockDirectory: "/run/lock/deviludo-agent-microvms",
    tapDeviceName: "tap0",
    guestMacAddress: "06:00:ac:10:00:02",
    jailerUid: 10000,
    jailerGid: 10000,
    parentCgroup: "deviludo-agent",
    vcpuCount: 4,
    memoryMib: 8192,
    dataDriveSizeMib: 8192,
    bootArgs: "reboot=k panic=1 pci=off 8250.nr_uarts=0 ip=172.20.0.2::172.20.0.1:255.255.255.0::eth0:off",
    maxRunSeconds: 7200,
    ...overrides,
  };
}

function claims(input: Readonly<{ launcherDigest: string; launcherSizeBytes: number; buildReceiptDigest: string;
  configDigest: string }>) {
  const value = config();
  return Object.freeze({
    kind: "deviludo-agent-microvm-launcher",
    version: 1,
    releaseId: "11111111-1111-4111-8111-111111111111",
    platformVersion: value.platformVersion,
    sourceRevision: "a".repeat(40),
    nodeTarget: "22.13",
    launcherDigest: input.launcherDigest,
    launcherSizeBytes: input.launcherSizeBytes,
    buildReceiptDigest: input.buildReceiptDigest,
    configDigest: input.configDigest,
    firecrackerVersion: value.firecrackerVersion,
    firecrackerDigest: value.firecrackerDigest,
    jailerDigest: value.jailerDigest,
    kernelDigest: value.kernelDigest,
    rootfsDigest: value.rootfsDigest,
    mke2fsDigest: value.mke2fsDigest,
    debugfsDigest: value.debugfsDigest,
    sbomDigest: "7".repeat(64),
    malwareScanDigest: "8".repeat(64),
    vulnerabilityScanDigest: "9".repeat(64),
    provenanceDigest: "b".repeat(64),
    publishedAt: "2026-07-24T00:00:00.000Z",
  });
}

test("Firecracker launcher configuration compiles only fixed jailer and VM arguments", () => {
  const parsed = parseNativeMicrovmLauncherConfig(config());
  assert.deepEqual(compileFirecrackerConfiguration(parsed), {
    "boot-source": { kernel_image_path: "/kernel", boot_args: parsed.bootArgs },
    drives: [
      { drive_id: "rootfs", path_on_host: "/rootfs.ext4", is_root_device: true, is_read_only: true },
      { drive_id: "deviludo-data", path_on_host: "/data.ext4", is_root_device: false, is_read_only: false },
    ],
    "machine-config": { vcpu_count: 4, mem_size_mib: 8192, smt: false, track_dirty_pages: false },
    "network-interfaces": [{ iface_id: "agent-egress", guest_mac: "06:00:ac:10:00:02", host_dev_name: "tap0" }],
  });
  const args = compileJailerArguments(parsed, "dl-444444444444-111111111111", "/run/netns/deviludo-agent-001");
  assert.deepEqual(args.slice(0, 6), ["--id", "dl-444444444444-111111111111", "--exec-file", parsed.firecrackerExecutable, "--uid", "10000"]);
  assert.deepEqual(args.slice(-3), ["--", "--config-file", "/machine-config.json"]);
  assert.equal(args.includes("--no-seccomp"), false);
  assert.equal(args.includes("--daemonize"), false);
  assert.deepEqual(parseNativeMicrovmLauncherArguments([
    "execute", "--config-file", "/etc/deviludo/launcher.json", "--request-file", "/run/job/control/request.json",
    "--workspace", "/run/job/workspace", "--response-file", "/run/job/control/response.json",
  ]).command, "execute");
  assert.throws(() => parseNativeMicrovmLauncherConfig(config({ bootArgs: "init=/bin/sh reboot=k panic=1 pci=off 8250.nr_uarts=0 ip=dhcp" })),
    /launcher input is invalid/);
  assert.throws(() => parseNativeMicrovmLauncherArguments(["execute", "--config-file", "/x", "--shell", "bash"]),
    /launcher input is invalid/);
});

test("signed launcher release binds every privileged runtime digest and rejects revocation", () => {
  const input = { launcherDigest: "c".repeat(64), launcherSizeBytes: 1024, buildReceiptDigest: "d".repeat(64),
    configDigest: "e".repeat(64) };
  const releaseClaims = claims(input);
  const release = Object.freeze({ keyId, claims: releaseClaims, signature: signCanonical(keys.privateKey, releaseClaims) });
  assert.deepEqual(verifySignedAgentMicrovmLauncherRelease(release, { trustPolicy, trustPolicyDigest,
    platformVersion: "0.1.0-beta.1", launcherDigest: input.launcherDigest,
    buildReceiptDigest: input.buildReceiptDigest, config: config(), configDigest: input.configDigest,
    now: new Date("2026-07-24T00:01:00.000Z") }), releaseClaims);
  const changed = { ...config(), kernelDigest: "f".repeat(64) };
  assert.throws(() => verifySignedAgentMicrovmLauncherRelease(release, { trustPolicy, trustPolicyDigest,
    platformVersion: "0.1.0-beta.1", launcherDigest: input.launcherDigest,
    buildReceiptDigest: input.buildReceiptDigest, config: changed, configDigest: input.configDigest,
    now: new Date("2026-07-24T00:01:00.000Z") }), /release is invalid/);
  const revoked = { ...trustPolicy, keys: trustPolicy.keys.map((key) => ({ ...key, status: "REVOKED" })) };
  assert.throws(() => verifySignedAgentMicrovmLauncherRelease(release, { trustPolicy: revoked,
    trustPolicyDigest: agentMicrovmLauncherTrustPolicyDigest(revoked), platformVersion: "0.1.0-beta.1",
    launcherDigest: input.launcherDigest, buildReceiptDigest: input.buildReceiptDigest,
    config: config(), configDigest: input.configDigest, now: new Date("2026-07-24T00:01:00.000Z") }), /release is invalid/);
  assert.deepEqual(validateAgentMicrovmLauncherTrustPolicy(trustPolicy), trustPolicy);
});

test("Worker authenticates launcher bytes before any production composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-microvm-release-"));
  const launcher = Buffer.from("#!/usr/bin/node\nlocked launcher\n");
  const configBytes = Buffer.from(JSON.stringify(config()));
  const buildReceipt = Buffer.from('{"schemaVersion":"deviludo.agent-microvm-launcher-build-receipt.v1"}\n');
  const input = { launcherDigest: digest(launcher), launcherSizeBytes: launcher.length, buildReceiptDigest: digest(buildReceipt),
    configDigest: digest(configBytes) };
  const releaseClaims = claims(input);
  const release = { keyId, claims: releaseClaims, signature: signCanonical(keys.privateKey, releaseClaims) };
  const paths = { launcher: join(root, "launcher.mjs"), config: join(root, "config.json"), build: join(root, "build.json"),
    release: join(root, "release.json"), policy: join(root, "policy.json") };
  await Promise.all([
    writeFile(paths.launcher, launcher, { mode: 0o500 }), writeFile(paths.config, configBytes),
    writeFile(paths.build, buildReceipt), writeFile(paths.release, JSON.stringify(release)),
    writeFile(paths.policy, JSON.stringify(trustPolicy)),
  ]);
  const env = {
    DEVILUDO_PLATFORM_VERSION: "0.1.0-beta.1",
    DEVILUDO_AGENT_MICROVM_EXECUTABLE: paths.launcher,
    DEVILUDO_AGENT_MICROVM_EXECUTABLE_DIGEST: input.launcherDigest,
    DEVILUDO_AGENT_MICROVM_CONFIG_FILE: paths.config,
    DEVILUDO_AGENT_MICROVM_CONFIG_DIGEST: input.configDigest,
    DEVILUDO_AGENT_MICROVM_BUILD_RECEIPT_FILE: paths.build,
    DEVILUDO_AGENT_MICROVM_RELEASE_FILE: paths.release,
    DEVILUDO_AGENT_MICROVM_TRUST_POLICY_FILE: paths.policy,
    DEVILUDO_AGENT_MICROVM_TRUST_POLICY_DIGEST: trustPolicyDigest,
  };
  assert.deepEqual(await verifyAgentMicrovmLauncherRuntimeFromEnv(env, new Date("2026-07-24T00:01:00.000Z")), releaseClaims);
  await chmod(paths.launcher, 0o600);
  await writeFile(paths.launcher, "tampered launcher\n");
  await assert.rejects(verifyAgentMicrovmLauncherRuntimeFromEnv(env, new Date("2026-07-24T00:01:00.000Z")),
    /runtime is invalid/);
});

function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
