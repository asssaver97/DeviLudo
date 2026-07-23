import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildAgentMicrovmLauncher,
  parseAgentMicrovmLauncherBuildArguments,
  validateAgentMicrovmLauncherBuildReceipt,
} from "../scripts/build-agent-microvm-launcher.mjs";
import {
  finalizeAgentMicrovmLauncher,
  MtlsAgentMicrovmLauncherSigner,
  parseAgentMicrovmLauncherFinalizationArguments,
  prepareAgentMicrovmLauncherClaims,
} from "../scripts/production/finalize-agent-microvm-launcher.mjs";
import {
  inspectAgentMicrovmLauncherTrustPolicy,
  parseAgentMicrovmLauncherTrustInspectionArguments,
} from "../scripts/production/inspect-agent-microvm-launcher-trust-policy.mjs";
import {
  agentMicrovmLauncherTrustPolicyDigest,
  verifySignedAgentMicrovmLauncherRelease,
} from "../services/agent-execution-broker/src/native-microvm-launcher-release.ts";

const sourceRevision = "a".repeat(40);
const keys = generateKeyPairSync("ed25519");
const keyId = "agent-microvm-launcher-2026-01";
const trustPolicy = Object.freeze({
  schemaVersion: "deviludo.agent-microvm-launcher-trust-policy.v1",
  policyId: "deviludo-agent-microvm-production",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({ keyId, algorithm: "Ed25519",
    publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z", status: "ACTIVE" })]),
});
const trustPolicyDigest = agentMicrovmLauncherTrustPolicyDigest(trustPolicy);

test("microVM launcher builder emits one source and toolchain bound candidate", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-microvm-build-"));
  const outputParent = resolve(root, "out"); const outputDirectory = resolve(outputParent, "release");
  await Promise.all([mkdir(outputParent), mkdir(resolve(root, "node_modules/esbuild/lib"), { recursive: true }),
    mkdir(resolve(root, "services/agent-execution-broker/src"), { recursive: true })]);
  await Promise.all([
    writeFile(resolve(root, "package.json"), JSON.stringify({ version: "0.1.0-beta.1", devDependencies: { esbuild: "0.28.0" } })),
    writeFile(resolve(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/esbuild": {
      version: "0.28.0", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz",
      integrity: "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==",
    } } })),
    writeFile(resolve(root, "node_modules/esbuild/lib/main.js"), "fixed esbuild library\n"),
    writeFile(resolve(root, "services/agent-execution-broker/src/native-microvm-launcher.ts"), "entry\n"),
  ]);
  const result = await buildAgentMicrovmLauncher({ outputDirectory, sourceRevision }, { root,
    verifySource: async (receivedRoot, receivedRevision) => { assert.equal(receivedRoot, root); assert.equal(receivedRevision, sourceRevision); },
    uuid: () => "11111111-1111-4111-8111-111111111111", now: () => new Date("2026-07-24T00:00:00.000Z"),
    bundle: async (options) => { assert.equal(options.target, "node22.13"); assert.equal(options.format, "esm");
      await writeFile(options.outfile, "#!/usr/bin/node\nlocked Firecracker launcher\n");
      return { metafile: { inputs: { "entry.ts": {}, "contract.ts": {} } } }; },
  });
  const { outputDirectory: published, ...receipt } = result;
  assert.equal(published, outputDirectory);
  assert.deepEqual(validateAgentMicrovmLauncherBuildReceipt(receipt), receipt);
  assert.equal(receipt.bundleInputCount, 2);
  assert.deepEqual(JSON.parse(await readFile(resolve(outputDirectory, "agent-microvm-launcher-build-receipt.json"))), receipt);
  assert.deepEqual(parseAgentMicrovmLauncherBuildArguments(["--source-revision", sourceRevision,
    "--output-directory", outputDirectory]), { outputDirectory, sourceRevision });
});

test("microVM finalizer binds scanned launcher, config and all Firecracker inputs to one KMS envelope", async () => {
  const fixture = await fixtureFiles();
  const claims = await prepareAgentMicrovmLauncherClaims(fixture.options);
  const calls = [];
  const signer = new MtlsAgentMicrovmLauncherSigner({ endpoint: "https://agent-microvm-kms.internal:8443/", keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    request: async (input) => { calls.push(input); const body = JSON.parse(input.body); return { statusCode: 200, body: {
      schemaVersion: "deviludo.agent-microvm-launcher-signing-response.v1", algorithm: "Ed25519", keyId,
      claimsDigest: body.claimsDigest,
      signature: sign(null, Buffer.from(body.signingInput, "base64url"), keys.privateKey).toString("base64url"),
    } }; },
  });
  const finalized = await finalizeAgentMicrovmLauncher(fixture.options, { signer, now: new Date("2026-07-24T00:02:00.000Z") });
  assert.equal(finalized.replayed, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://agent-microvm-kms.internal:8443/v1/agent-microvm-launchers/sign-ed25519");
  assert.deepEqual(verifySignedAgentMicrovmLauncherRelease(finalized.manifest, { trustPolicy, trustPolicyDigest,
    platformVersion: claims.platformVersion, launcherDigest: claims.launcherDigest,
    buildReceiptDigest: claims.buildReceiptDigest, config: fixture.config, configDigest: claims.configDigest,
    now: new Date("2026-07-24T00:02:00.000Z") }), claims);
  const argv = ["--artifact", fixture.options.artifactPath, "--build-receipt", fixture.options.buildReceiptPath,
    "--config", fixture.options.configPath, "--evidence", fixture.options.evidencePath,
    "--output", fixture.options.outputPath, "--published-at", fixture.options.publishedAt,
    "--release-id", fixture.options.releaseId, "--source-revision", fixture.options.sourceRevision,
    "--trust-policy", fixture.options.trustPolicyPath, "--trust-policy-digest", fixture.options.trustPolicyDigest];
  assert.equal(parseAgentMicrovmLauncherFinalizationArguments(argv).releaseId, fixture.options.releaseId);
  const replay = await finalizeAgentMicrovmLauncher(fixture.options, { signer: { async sign() { throw new Error("must not sign replay"); } },
    now: new Date("2026-07-24T00:03:00.000Z") });
  assert.equal(replay.replayed, true);
  await writeFile(fixture.options.configPath, JSON.stringify({ ...fixture.config, kernelDigest: "f".repeat(64) }));
  await assert.rejects(finalizeAgentMicrovmLauncher(fixture.options, { signer, now: new Date("2026-07-24T00:03:00.000Z") }),
    /finalization input is invalid/);
});

test("launcher trust inspection hides key bytes and the shipped template is revoked", async () => {
  const inspected = inspectAgentMicrovmLauncherTrustPolicy(trustPolicy);
  assert.equal(inspected.policyDigest, trustPolicyDigest);
  assert.equal(JSON.stringify(inspected).includes("publicKeySpkiBase64"), false);
  const template = JSON.parse(await readFile(new URL("../infra/agent-microvm-launcher-trust-policy.example.json", import.meta.url)));
  assert.equal(template.keys[0].status, "REVOKED");
  assert.equal(inspectAgentMicrovmLauncherTrustPolicy(template).keys[0].status, "REVOKED");
  assert.deepEqual(parseAgentMicrovmLauncherTrustInspectionArguments(["--trust-policy", "/private/reviewed/microvm.json"]),
    { trustPolicyPath: "/private/reviewed/microvm.json" });
  assert.throws(() => parseAgentMicrovmLauncherTrustInspectionArguments(["--trust-policy", "relative.json"]), /input is invalid/);
});

async function fixtureFiles() {
  const root = await mkdtemp(resolve(tmpdir(), "deviludo-microvm-finalize-"));
  const artifactPath = resolve(root, "deviludo-agent-microvm-launcher.mjs");
  const buildReceiptPath = resolve(root, "agent-microvm-launcher-build-receipt.json");
  const configPath = resolve(root, "launcher-config.json"); const evidencePath = resolve(root, "evidence.json");
  const outputPath = resolve(root, "release.json"); const trustPolicyPath = resolve(root, "trust-policy.json");
  const artifact = Buffer.from("#!/usr/bin/node\nlocked Firecracker launcher\n");
  const config = {
    schemaVersion: "deviludo.agent-microvm-launcher-config.v1", backend: "firecracker-jailer",
    platformVersion: "0.1.0-beta.1", firecrackerVersion: "1.13.1",
    firecrackerExecutable: "/opt/deviludo/firecracker/firecracker", firecrackerDigest: "1".repeat(64),
    jailerExecutable: "/opt/deviludo/firecracker/jailer", jailerDigest: "2".repeat(64),
    kernelImage: "/opt/deviludo/microvm/vmlinux", kernelDigest: "3".repeat(64),
    rootfsImage: "/opt/deviludo/microvm/agent-guest.ext4", rootfsDigest: "4".repeat(64),
    mke2fsExecutable: "/usr/sbin/mke2fs", mke2fsDigest: "5".repeat(64),
    debugfsExecutable: "/usr/sbin/debugfs", debugfsDigest: "6".repeat(64),
    chrootBaseDirectory: "/var/lib/deviludo/firecracker-jails", networkNamespaceDirectory: "/run/netns",
    networkNamespaceNames: ["deviludo-agent-001"], networkLockDirectory: "/run/lock/deviludo-agent-microvms",
    tapDeviceName: "tap0", guestMacAddress: "06:00:ac:10:00:02", jailerUid: 10000, jailerGid: 10000,
    parentCgroup: "deviludo-agent", vcpuCount: 4, memoryMib: 8192, dataDriveSizeMib: 8192,
    bootArgs: "reboot=k panic=1 pci=off 8250.nr_uarts=0 ip=172.20.0.2::172.20.0.1:255.255.255.0::eth0:off",
    maxRunSeconds: 7200,
  };
  const configBytes = Buffer.from(JSON.stringify(config));
  const buildReceipt = { schemaVersion: "deviludo.agent-microvm-launcher-build-receipt.v1", status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1", sourceRevision, nodeTarget: "22.13", packageLockDigest: "7".repeat(64),
    esbuildVersion: "0.28.0", esbuildLibraryDigest: "8".repeat(64),
    entryPoint: "services/agent-execution-broker/src/native-microvm-launcher.ts",
    artifactFileName: "deviludo-agent-microvm-launcher.mjs", artifactDigest: digest(artifact), sizeBytes: artifact.length,
    bundleInputCount: 10, bundleInputDigest: "9".repeat(64), completedAt: "2026-07-24T00:00:00.000Z" };
  const buildBytes = Buffer.from(`${JSON.stringify(buildReceipt)}\n`);
  const evidence = { schemaVersion: "deviludo.agent-microvm-launcher-evidence.v1", scanState: "PASS",
    artifactDigest: digest(artifact), buildReceiptDigest: digest(buildBytes), configDigest: digest(configBytes),
    sbomDigest: "a".repeat(64), malwareScanDigest: "b".repeat(64), vulnerabilityScanDigest: "c".repeat(64),
    provenanceDigest: "d".repeat(64) };
  await Promise.all([writeFile(artifactPath, artifact, { mode: 0o500 }), writeFile(buildReceiptPath, buildBytes),
    writeFile(configPath, configBytes), writeFile(evidencePath, JSON.stringify(evidence)),
    writeFile(trustPolicyPath, JSON.stringify(trustPolicy))]);
  return { config, options: { artifactPath, buildReceiptPath, configPath, evidencePath, outputPath,
    publishedAt: "2026-07-24T00:01:00.000Z", releaseId: "11111111-1111-4111-8111-111111111111",
    sourceRevision, trustPolicyPath, trustPolicyDigest } };
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
