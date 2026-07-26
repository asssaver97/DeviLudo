import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signCanonical } from "../../runner-control/src/canonical";
import {
  assertAgentMicrovmGuestIdentity,
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
import { agentMicrovmGuestTrustPolicyDigest } from "../src/native-microvm-guest-release";
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
const guestTrustPolicy = Object.freeze({
  schemaVersion: "deviludo.agent-microvm-guest-trust-policy.v1",
  policyId: "deviludo-agent-microvm-guest-production",
  policyRevision: 1,
  keys: trustPolicy.keys,
});

function config(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "deviludo.agent-microvm-launcher-config.v2",
    backend: "firecracker-jailer",
    platformVersion: "0.1.0-beta.1",
    firecrackerVersion: "1.13.1",
    firecrackerExecutable: "/opt/deviludo/firecracker/firecracker",
    firecrackerDigest: "1".repeat(64),
    jailerExecutable: "/opt/deviludo/firecracker/jailer",
    jailerDigest: "2".repeat(64),
    kernelImage: "/opt/deviludo/microvm/vmlinux",
    kernelDigest: "3".repeat(64),
    rootfsImage: "/opt/deviludo/microvm/agent-microvm-guest.squashfs",
    rootfsDigest: "4".repeat(64),
    rootfsReleaseFile: "/opt/deviludo/microvm/agent-microvm-guest-release.json",
    rootfsReleaseDigest: "7".repeat(64),
    rootfsTrustPolicyFile: "/etc/deviludo/agent-microvm-guest-trust-policy.json",
    rootfsTrustPolicyDigest: "8".repeat(64),
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
    bootArgs: "reboot=k panic=1 pci=off 8250.nr_uarts=0 root=/dev/vda rootfstype=squashfs ro ip=172.20.0.2::172.20.0.1:255.255.255.0::eth0:off",
    maxRunSeconds: 7200,
    ...overrides,
  };
}

function claims(input: Readonly<{ launcherDigest: string; launcherSizeBytes: number; buildReceiptDigest: string;
  configDigest: string }>, value = config()) {
  return Object.freeze({
    kind: "deviludo-agent-microvm-launcher",
    version: 2,
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
    rootfsReleaseDigest: value.rootfsReleaseDigest,
    rootfsTrustPolicyDigest: value.rootfsTrustPolicyDigest,
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
      { drive_id: "rootfs", path_on_host: "/rootfs.squashfs", is_root_device: true, is_read_only: true },
      { drive_id: "deviludo-data", path_on_host: "/data.ext4", is_root_device: false, is_read_only: false },
      { drive_id: "deviludo-credentials", path_on_host: "/credentials.ext4", is_root_device: false, is_read_only: true },
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
    "--credential-image", "/run/job/control/credentials.ext4",
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
  const buildReceipt = Buffer.from('{"schemaVersion":"deviludo.agent-microvm-launcher-build-receipt.v1"}\n');
  const paths = { launcher: join(root, "launcher.mjs"), config: join(root, "config.json"), build: join(root, "build.json"),
    release: join(root, "release.json"), policy: join(root, "policy.json"), guestRelease: join(root, "guest-release.json"),
    guestPolicy: join(root, "guest-policy.json"), firecracker: join(root, "firecracker"), jailer: join(root, "jailer"),
    kernel: join(root, "vmlinux"), rootfs: join(root, "guest.squashfs"), mke2fs: join(root, "mke2fs"), debugfs: join(root, "debugfs") };
  const runtimeBytes = { firecracker: Buffer.from("firecracker"), jailer: Buffer.from("jailer"), kernel: Buffer.from("kernel"),
    rootfs: Buffer.alloc(4096, 4), mke2fs: Buffer.from("mke2fs"), debugfs: Buffer.from("debugfs") };
  const runtimeConfig = config({ firecrackerExecutable: paths.firecracker, firecrackerDigest: digest(runtimeBytes.firecracker),
    jailerExecutable: paths.jailer, jailerDigest: digest(runtimeBytes.jailer), kernelImage: paths.kernel,
    kernelDigest: digest(runtimeBytes.kernel), rootfsImage: paths.rootfs, rootfsDigest: digest(runtimeBytes.rootfs),
    mke2fsExecutable: paths.mke2fs, mke2fsDigest: digest(runtimeBytes.mke2fs), debugfsExecutable: paths.debugfs,
    debugfsDigest: digest(runtimeBytes.debugfs) });
  const guestClaims = { kind: "deviludo-agent-microvm-guest", version: 1,
    releaseId: "22222222-2222-4222-8222-222222222222", platformVersion: "0.1.0-beta.1", sourceRevision: "a".repeat(40),
    agent: "claude-code", exactAgentVersion: "2.1.14", adapterVersion: "1.3.0",
    workerImageDigest: `sha256:${"c".repeat(64)}`, rootfsFormat: "squashfs", rootfsDigest: runtimeConfig.rootfsDigest,
    rootfsSizeBytes: 4096, buildReceiptDigest: "5".repeat(64), sourceDateEpoch: 1767225600,
    sbomDigest: "6".repeat(64), malwareScanDigest: "7".repeat(64), vulnerabilityScanDigest: "8".repeat(64),
    secretScanDigest: "9".repeat(64), provenanceDigest: "b".repeat(64), embeddedSecrets: false,
    selfUpdateDisabled: true, publishedAt: "2026-07-24T00:00:00.000Z" } as const;
  const guestManifest = { keyId, claims: guestClaims, signature: signCanonical(keys.privateKey, guestClaims) };
  assert.doesNotThrow(() => assertAgentMicrovmGuestIdentity(guestClaims, { agent: "claude-code", exactAgentVersion: "2.1.14",
    adapterVersion: "1.3.0", imageDigest: `sha256:${"c".repeat(64)}` }));
  assert.throws(() => assertAgentMicrovmGuestIdentity(guestClaims, { agent: "codex-cli", exactAgentVersion: "2.1.14",
    adapterVersion: "1.3.0", imageDigest: `sha256:${"c".repeat(64)}` }), /launcher input is invalid/);
  const guestReleaseBytes = Buffer.from(JSON.stringify(guestManifest));
  const guestPolicyBytes = Buffer.from(JSON.stringify(guestTrustPolicy));
  const configBytes = Buffer.from(JSON.stringify({ ...runtimeConfig, rootfsReleaseFile: paths.guestRelease,
    rootfsReleaseDigest: digest(guestReleaseBytes), rootfsTrustPolicyFile: paths.guestPolicy,
    rootfsTrustPolicyDigest: agentMicrovmGuestTrustPolicyDigest(guestTrustPolicy) }));
  const input = { launcherDigest: digest(launcher), launcherSizeBytes: launcher.length, buildReceiptDigest: digest(buildReceipt),
    configDigest: digest(configBytes) };
  const releaseClaims = claims(input, JSON.parse(configBytes.toString("utf8")));
  const release = { keyId, claims: releaseClaims, signature: signCanonical(keys.privateKey, releaseClaims) };
  await Promise.all([
    writeFile(paths.launcher, launcher, { mode: 0o500 }), writeFile(paths.config, configBytes),
    writeFile(paths.build, buildReceipt), writeFile(paths.release, JSON.stringify(release)),
    writeFile(paths.policy, JSON.stringify(trustPolicy)), writeFile(paths.guestRelease, guestReleaseBytes),
    writeFile(paths.guestPolicy, guestPolicyBytes),
    writeFile(paths.firecracker, runtimeBytes.firecracker, { mode: 0o500 }),
    writeFile(paths.jailer, runtimeBytes.jailer, { mode: 0o500 }), writeFile(paths.kernel, runtimeBytes.kernel, { mode: 0o400 }),
    writeFile(paths.rootfs, runtimeBytes.rootfs, { mode: 0o400 }), writeFile(paths.mke2fs, runtimeBytes.mke2fs, { mode: 0o500 }),
    writeFile(paths.debugfs, runtimeBytes.debugfs, { mode: 0o500 }),
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
