import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildAgentMicrovmGuestRootfs,
  parseAgentMicrovmGuestRootfsBuildArguments,
  validateAgentMicrovmGuestRootfsBuildReceipt,
} from "../scripts/production/build-agent-microvm-guest-rootfs.mjs";
import {
  finalizeAgentMicrovmGuestRootfs,
  MtlsAgentMicrovmGuestSigner,
  parseAgentMicrovmGuestFinalizationArguments,
  prepareAgentMicrovmGuestClaims,
} from "../scripts/production/finalize-agent-microvm-guest-rootfs.mjs";
import {
  agentMicrovmGuestTrustPolicyDigest,
  verifySignedAgentMicrovmGuestRelease,
} from "../services/agent-execution-broker/src/native-microvm-guest-release.ts";
import { inspectAgentMicrovmGuestTrustPolicy } from "../scripts/production/inspect-agent-microvm-guest-trust-policy.mjs";
import { signCanonical } from "../services/runner-control/src/canonical.ts";

const sourceRevision = "a".repeat(40);
const workerImage = `registry.internal/deviludo/agents/claude-code:build-locked@sha256:${"b".repeat(64)}`;
const nodeBaseImage = `registry.internal/runtime/node:22.13.1-bookworm-slim@sha256:${"c".repeat(64)}`;
const keys = generateKeyPairSync("ed25519"); const keyId = "agent-microvm-guest-2026-01";
const trustPolicy = Object.freeze({ schemaVersion: "deviludo.agent-microvm-guest-trust-policy.v1",
  policyId: "deviludo-agent-microvm-guest-production", policyRevision: 1,
  keys: Object.freeze([Object.freeze({ keyId, algorithm: "Ed25519",
    publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z", status: "ACTIVE" })]) });
const trustPolicyDigest = agentMicrovmGuestTrustPolicyDigest(trustPolicy);

test("guest image bundles its production service and leaves all credentials on the attempt drive", async () => {
  const [dockerfile, init] = await Promise.all([
    readFile(new URL("../Dockerfile.agent-microvm-guest", import.meta.url), "utf8"),
    readFile(new URL("../scripts/production/agent-microvm-guest-init.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(dockerfile, /--bundle --platform=node --target=node22\.13 --format=esm --packages=bundle/);
  assert.match(dockerfile, /FROM scratch AS rootfs/); assert.doesNotMatch(init, /--import["', ]+tsx/);
  assert.match(init, /\/dev\/vdc/); assert.match(init, /ro,nosuid,nodev,noexec/);
  assert.doesNotMatch(dockerfile, /(?:API_KEY|PRIVATE_KEY|config\.vdf)/);
});

test("guest rootfs builder exports one deterministic secret-free SquashFS candidate", async () => {
  const fixture = await buildFixture(); const commands = [];
  const result = await buildAgentMicrovmGuestRootfs(fixture.options, { root: resolve("."),
    verifySource: async (_root, revision) => assert.equal(revision, sourceRevision), uuid: () => "11111111-1111-4111-8111-111111111111",
    now: () => new Date("2026-07-26T00:00:00.000Z"), process: async (command, args) => {
      commands.push({ command, args });
      if (command === "docker") { const destination = args.find((value) => value.startsWith("type=local,dest=")).slice(16);
        await populateRootfs(destination, "claude-code"); return { exitCode: 0, stdout: "build complete", stderr: "" }; }
      if (args[0] === "-version") return { exitCode: 0, stdout: "mksquashfs version 4.6.1", stderr: "" };
      await writeFile(args[1], Buffer.alloc(4096, 42)); return { exitCode: 0, stdout: "", stderr: "" };
    } });
  assert.equal(result.rootfsFormat, "squashfs"); assert.equal(result.embeddedSecrets, false);
  assert.equal(result.workerImageDigest, `sha256:${"b".repeat(64)}`);
  const { outputDirectory: _outputDirectory, ...resultReceipt } = result;
  assert.equal(_outputDirectory, fixture.outputDirectory);
  assert.deepEqual(validateAgentMicrovmGuestRootfsBuildReceipt(resultReceipt), resultReceipt);
  const receipt = JSON.parse(await readFile(join(fixture.outputDirectory, "agent-microvm-guest-build-receipt.json"), "utf8"));
  assert.deepEqual(validateAgentMicrovmGuestRootfsBuildReceipt(receipt), receipt);
  const squash = commands.find((command) => command.args.includes("-noappend"));
  assert.ok(squash.args.includes("-all-root")); assert.ok(squash.args.includes("-no-xattrs"));
  assert.equal(squash.args.at(-2), "-root-mode"); assert.equal(squash.args.at(-1), "0755");
  const argv = ["--agent", "claude-code", "--exact-agent-version", "2.1.14", "--adapter-version", "1.3.0",
    "--worker-image", workerImage, "--node-base-image", nodeBaseImage, "--source-revision", sourceRevision,
    "--source-date-epoch", "1767225600", "--mksquashfs", fixture.mksquashfs,
    "--mksquashfs-digest", fixture.mksquashfsDigest, "--output-directory", fixture.outputDirectory];
  assert.equal(parseAgentMicrovmGuestRootfsBuildArguments(argv).agent, "claude-code");
});

test("guest finalizer binds WorkerImage, rootfs and scan evidence to an independent KMS envelope", async () => {
  const fixture = await finalizedFixture(); const claims = await prepareAgentMicrovmGuestClaims(fixture.options); const calls = [];
  const signer = new MtlsAgentMicrovmGuestSigner({ endpoint: "https://agent-microvm-kms.internal:8443/", keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) }, request: async (input) => {
      calls.push(input); const body = JSON.parse(input.body); return { statusCode: 200, body: {
        schemaVersion: "deviludo.agent-microvm-guest-signing-response.v1", algorithm: "Ed25519", keyId,
        claimsDigest: body.claimsDigest, signature: sign(null, Buffer.from(body.signingInput, "base64url"), keys.privateKey).toString("base64url"),
      } }; } });
  const result = await finalizeAgentMicrovmGuestRootfs(fixture.options, { signer, now: new Date("2026-07-26T00:02:00.000Z") });
  assert.equal(result.replayed, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v1/agent-microvm-guests/sign-ed25519");
  const releaseBytes = await readFile(fixture.options.outputPath);
  assert.deepEqual(verifySignedAgentMicrovmGuestRelease(result.manifest, { trustPolicy, trustPolicyDigest,
    platformVersion: claims.platformVersion, rootfsDigest: claims.rootfsDigest,
    releaseDigest: digest(releaseBytes), releaseBytes, now: new Date("2026-07-26T00:02:00.000Z") }), claims);
  const replay = await finalizeAgentMicrovmGuestRootfs(fixture.options, { signer: { async sign() { throw new Error("must not sign replay"); } },
    now: new Date("2026-07-26T00:03:00.000Z") }); assert.equal(replay.replayed, true);
  const argv = ["--rootfs", fixture.options.rootfsPath, "--build-receipt", fixture.options.buildReceiptPath,
    "--evidence", fixture.options.evidencePath, "--output", fixture.options.outputPath,
    "--published-at", fixture.options.publishedAt, "--release-id", fixture.options.releaseId,
    "--source-revision", sourceRevision, "--trust-policy", fixture.options.trustPolicyPath,
    "--trust-policy-digest", trustPolicyDigest];
  assert.equal(parseAgentMicrovmGuestFinalizationArguments(argv).releaseId, fixture.options.releaseId);
});

test("guest trust inspection redacts key bytes and revoked keys cannot authorize a rootfs", async () => {
  const inspected = inspectAgentMicrovmGuestTrustPolicy(trustPolicy);
  assert.equal(inspected.policyDigest, trustPolicyDigest); assert.equal(JSON.stringify(inspected).includes("publicKeySpkiBase64"), false);
  const template = JSON.parse(await readFile(new URL("../infra/agent-microvm-guest-trust-policy.example.json", import.meta.url)));
  assert.equal(template.keys[0].status, "REVOKED");
  const fixture = await finalizedFixture(); const claims = await prepareAgentMicrovmGuestClaims(fixture.options);
  const manifest = { keyId, claims, signature: signCanonical(keys.privateKey, claims) };
  const revoked = { ...trustPolicy, keys: trustPolicy.keys.map((key) => ({ ...key, status: "REVOKED" })) };
  assert.throws(() => verifySignedAgentMicrovmGuestRelease(manifest, { trustPolicy: revoked,
    trustPolicyDigest: agentMicrovmGuestTrustPolicyDigest(revoked), platformVersion: claims.platformVersion,
    rootfsDigest: claims.rootfsDigest, now: new Date("2026-07-26T00:02:00.000Z") }), /release is invalid/);
});

async function buildFixture() { const root = await mkdtemp(join(tmpdir(), "deviludo-guest-build-"));
  const outputDirectory = join(root, "release"); const mksquashfs = join(root, "mksquashfs");
  await writeFile(mksquashfs, "locked mksquashfs\n", { mode: 0o500 }); const mksquashfsDigest = digest(await readFile(mksquashfs));
  return { outputDirectory, mksquashfs, mksquashfsDigest, options: { agent: "claude-code", exactAgentVersion: "2.1.14",
    adapterVersion: "1.3.0", workerImage, nodeBaseImage, sourceRevision, sourceDateEpoch: 1767225600,
    mksquashfsExecutable: mksquashfs, mksquashfsDigest, outputDirectory } }; }
async function populateRootfs(root, agent) { const files = ["usr/bin/node", "bin/mount", "bin/umount", "sbin/poweroff", "sbin/deviludo-init",
  "opt/deviludo/agent-microvm-guest-service.mjs", agent === "claude-code" ? "usr/local/bin/claude" : "usr/local/bin/codex"];
  for (const relative of files) { const path = join(root, relative); await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, "locked\n", { mode: 0o500 }); } }
async function finalizedFixture() { const root = await mkdtemp(join(tmpdir(), "deviludo-guest-finalize-"));
  const rootfsPath = join(root, "agent-microvm-guest.squashfs"); const buildReceiptPath = join(root, "build.json");
  const evidencePath = join(root, "evidence.json"); const outputPath = join(root, "release.json"); const trustPolicyPath = join(root, "trust.json");
  const rootfs = Buffer.alloc(4096, 7); await writeFile(rootfsPath, rootfs, { mode: 0o400 }); const rootfsDigest = digest(rootfs);
  const buildReceipt = { schemaVersion: "deviludo.agent-microvm-guest-build-receipt.v1", status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1", sourceRevision, sourceDateEpoch: 1767225600, agent: "claude-code",
    exactAgentVersion: "2.1.14", adapterVersion: "1.3.0", workerImage, workerImageDigest: `sha256:${"b".repeat(64)}`,
    nodeBaseImage, rootfsFormat: "squashfs", rootfsFileName: "agent-microvm-guest.squashfs", rootfsDigest,
    rootfsSizeBytes: rootfs.length, mksquashfsDigest: "d".repeat(64), mksquashfsVersion: "4.6.1",
    dockerfileDigest: "e".repeat(64), packageLockDigest: "f".repeat(64), embeddedSecrets: false,
    selfUpdateDisabled: true, completedAt: "2026-07-26T00:00:00.000Z" };
  const buildBytes = Buffer.from(`${JSON.stringify(buildReceipt)}\n`); await writeFile(buildReceiptPath, buildBytes, { mode: 0o400 });
  const evidence = { schemaVersion: "deviludo.agent-microvm-guest-evidence.v1", scanState: "PASS", rootfsDigest,
    buildReceiptDigest: digest(buildBytes), sbomDigest: "1".repeat(64), malwareScanDigest: "2".repeat(64),
    vulnerabilityScanDigest: "3".repeat(64), secretScanDigest: "4".repeat(64), provenanceDigest: "5".repeat(64) };
  await Promise.all([writeFile(evidencePath, JSON.stringify(evidence), { mode: 0o400 }),
    writeFile(trustPolicyPath, JSON.stringify(trustPolicy), { mode: 0o400 })]);
  return { options: { rootfsPath, buildReceiptPath, evidencePath, outputPath, publishedAt: "2026-07-26T00:01:00.000Z",
    releaseId: "11111111-1111-4111-8111-111111111111", sourceRevision, trustPolicyPath, trustPolicyDigest } };
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
