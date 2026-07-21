import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentVersionCandidateReceipt } from "../../control-plane/src/agent-supply-chain";
import { extractOfficialNpmPackage } from "../src/npm-package-extractor";
import { NativeAgentSupplyChainController } from "../src/native-policy-controller";
import {
  NATIVE_POLICY_TOOL_IDS,
  parseNativeAgentSupplyChainPolicy,
} from "../src/native-policy-config";
import {
  LockedNativeSupplyChainTools,
  NativePolicyViolation,
  type NativeSupplyChainTools,
  type NativeToolProcess,
} from "../src/native-policy-tools";
import {
  OfficialNpmAgentRegistry,
  OfficialPackagePolicyError,
  type OfficialNpmTransport,
  type VerifiedAgentPackage,
} from "../src/official-npm-registry";
import { validateAgentSupplyChainResponse } from "../src/request-contract";

const version = "2.1.15";
const packageName = "@anthropic-ai/claude-code";
const archive = npmArchive([
  { path: "package/", type: "directory" },
  { path: "package/package.json", body: Buffer.from(JSON.stringify({ name: packageName, version })) },
  { path: "package/cli.js", body: Buffer.from("export default true;\n") },
]);
const archiveSha256 = digest(archive);
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const keyId = `SHA256:${createHash("sha256").update(Buffer.from(publicKeyDer, "base64")).digest("base64")}`;
const signature = (() => {
  const signer = createSign("SHA256");
  signer.update(`${packageName}@${version}:${integrity}`); signer.end();
  return signer.sign(privateKey).toString("base64");
})();

test("native policy accepts only exact official tools, agents, models and development pools", () => {
  const policy = parseNativeAgentSupplyChainPolicy(policyFixture());
  assert.equal(policy.agents["claude-code"].packageName, packageName);
  assert.throws(() => parseNativeAgentSupplyChainPolicy({ ...policyFixture(), policyVersion: "latest" }), /policy is invalid/);
  assert.throws(() => parseNativeAgentSupplyChainPolicy({
    ...policyFixture(),
    internalRegistryOrigin: "https://registry.npmjs.org",
  }), /policy is invalid/);
  const wrongTools = policyFixture();
  (wrongTools.tools as Record<string, unknown>).curl = { path: "/usr/bin/curl", digest: "a".repeat(64), version: "1.0.0" };
  assert.throws(() => parseNativeAgentSupplyChainPolicy(wrongTools), /policy is invalid/);
  const unknownAdapter = policyFixture();
  (unknownAdapter.agents as Record<string, Record<string, unknown>>)["codex-cli"]!.adapterVersion = "9.9.9";
  assert.throws(() => parseNativeAgentSupplyChainPolicy(unknownAdapter), /policy is invalid/);
});

test("official npm registry verifies its pinned ECDSA signature and package integrity", async () => {
  const policy = parseNativeAgentSupplyChainPolicy(policyFixture());
  const registry = new OfficialNpmAgentRegistry(policy, { transport: transport() });
  const release = await registry.resolve("claude-code", version);
  assert.equal(release.tarballUrl, `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`);
  const root = await mkdtemp(join(tmpdir(), "deviludo-official-npm-"));
  const artifact = await registry.download(release, join(root, "agent.tgz"));
  assert.equal(artifact.sha256, archiveSha256);

  const badRegistry = new OfficialNpmAgentRegistry(policy, { transport: transport({ signature: Buffer.alloc(64).toString("base64") }) });
  await assert.rejects(badRegistry.resolve("claude-code", version), (error) => error instanceof OfficialPackagePolicyError
    && error.code === "SIGNATURE_INVALID");
  const badDownload = new OfficialNpmAgentRegistry(policy, { transport: transport({ download: Buffer.concat([archive, Buffer.from("tamper")]) }) });
  const sameRelease = await badDownload.resolve("claude-code", version);
  await assert.rejects(badDownload.download(sameRelease, join(root, "tampered.tgz")), (error) => error instanceof OfficialPackagePolicyError
    && error.code === "INTEGRITY_MISMATCH");
});

test("npm extractor rejects traversal and non-regular archive entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-npm-extract-"));
  const valid = join(root, "valid.tgz");
  await writeFile(valid, archive);
  const extracted = await extractOfficialNpmPackage(valid, join(root, "valid"), { packageName, version, maximumBytes: 10 * 1024 * 1024 });
  assert.equal(extracted.files, 2);
  const malicious = join(root, "malicious.tgz");
  await writeFile(malicious, npmArchive([
    { path: "package/", type: "directory" },
    { path: "package/package.json", body: Buffer.from(JSON.stringify({ name: packageName, version })) },
    { path: "package/link", type: "symlink" },
  ]));
  await assert.rejects(extractOfficialNpmPackage(malicious, join(root, "malicious"), {
    packageName, version, maximumBytes: 10 * 1024 * 1024,
  }), /archive is invalid/);
});

test("native controller emits a fully bound discovery, validation, build and rollout receipt chain", async () => {
  const policy = parseNativeAgentSupplyChainPolicy(policyFixture());
  const registry = new OfficialNpmAgentRegistry(policy, { transport: transport() });
  const calls: string[] = [];
  const tools: NativeSupplyChainTools = {
    async probe() { calls.push("probe"); },
    async validate() {
      calls.push("validate");
      return { integrity: `sha256:${archiveSha256}`, sbomRef: `oci://registry.deviludo.test/sboms/claude-code@sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64) };
    },
    async build() { calls.push("build"); return { workerImageId: "worker-image-fixed-0001", imageDigest: `sha256:${"d".repeat(64)}` }; },
    async rollout() { calls.push("rollout"); },
  };
  const controller = new NativeAgentSupplyChainController(policy, registry, tools, () => new Date("2026-07-18T08:00:00.000Z"));
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-controller-"));
  const discoveryRequest = {
    schemaVersion: "deviludo.agent-version-discovery-request.v1" as const,
    operationKey: "1".repeat(64), requestDigest: "2".repeat(64), agent: "claude-code" as const, requestedVersion: version,
  };
  const discovery = await controller.execute(discoveryRequest, join(root, "discover"));
  const checkedDiscovery = validateAgentSupplyChainResponse(discovery, discoveryRequest);
  const candidate = (checkedDiscovery as { candidates: readonly AgentVersionCandidateReceipt[] }).candidates[0]!;
  const validationRequest = {
    schemaVersion: "deviludo.agent-version-validation-request.v1" as const,
    operationKey: "3".repeat(64), requestDigest: "4".repeat(64), candidate,
  };
  const validation = validateAgentSupplyChainResponse(
    await controller.execute(validationRequest, join(root, "validate")), validationRequest,
  );
  assert.equal((validation as { validatedAdapterVersion: string }).validatedAdapterVersion, "1.3.0");
  assert.deepEqual((validation as { adapterCompatibility: unknown }).adapterCompatibility, {
    min: "1.3.0", maxExclusive: "1.3.1",
  });
  const validationRetry = validateAgentSupplyChainResponse(
    await controller.execute(validationRequest, join(root, "validate")), validationRequest,
  );
  assert.deepEqual(validationRetry, validation);
  const buildRequest = {
    schemaVersion: "deviludo.agent-installation-build-request.v1" as const,
    operationKey: "5".repeat(64), requestDigest: "6".repeat(64), installationId: "claude-installation-001",
    candidate, validation: validation as Extract<typeof validation, { validationReceiptDigest: string }>,
    workerPool: "development-linux", adapterVersion: "1.3.0", rollbackInstallationId: null,
  };
  const build = validateAgentSupplyChainResponse(await controller.execute(buildRequest, join(root, "build")), buildRequest);
  const imageDigest = (build as { imageDigest: string }).imageDigest;
  const rolloutRequest = {
    schemaVersion: "deviludo.agent-installation-rollout-request.v1" as const,
    operationKey: "7".repeat(64), requestDigest: "8".repeat(64), installationId: "claude-installation-001",
    imageDigest, action: "ADVANCE" as const, fromPercent: 0 as const, toPercent: 5 as const,
  };
  const rollout = validateAgentSupplyChainResponse(await controller.execute(rolloutRequest, join(root, "rollout")), rolloutRequest);
  assert.equal((rollout as { state: string }).state, "CANARY");
  assert.deepEqual(calls, ["validate", "validate", "build", "rollout"]);
});

test("locked toolchain pins argv, quarantines malware and registers only a signed immutable image", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-tools-"));
  const toolsDirectory = join(root, "tools");
  const registry = join(root, "registry");
  const scanner = join(root, "scanner");
  await Promise.all([mkdir(toolsDirectory), mkdir(registry), mkdir(scanner)]);
  await writeFile(join(registry, "config.json"), "{}");
  const toolPaths: Record<string, string> = {};
  for (const id of NATIVE_POLICY_TOOL_IDS) {
    const path = join(toolsDirectory, id);
    await writeFile(path, `fixed-${id}`); await chmod(path, 0o500); toolPaths[id] = path;
  }
  const fleet = join(root, "fleet.json"); await writeFile(fleet, "{}");
  const raw = policyFixture();
  raw.registryConfigDirectory = registry; raw.scannerDataDirectory = scanner; raw.fleetConfigFile = fleet;
  raw.tools = Object.fromEntries(NATIVE_POLICY_TOOL_IDS.map((id) => [id, {
    path: toolPaths[id], digest: digest(Buffer.from(`fixed-${id}`)), version: "1.0.0",
  }]));
  const policy = parseNativeAgentSupplyChainPolicy(raw);
  const work = join(root, "work"); const extracted = join(root, "extracted");
  await Promise.all([mkdir(work), mkdir(extracted)]);
  const artifactPath = join(root, "agent.tgz"); await writeFile(artifactPath, archive);
  const artifact: VerifiedAgentPackage = { path: artifactPath, sizeBytes: archive.length, sha256: archiveSha256, sha512Base64: integrity.slice(7) };
  const release = await new OfficialNpmAgentRegistry(policy, { transport: transport() }).resolve("claude-code", version);
  const calls: Array<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const process: NativeToolProcess = async (executable, args, options) => {
    calls.push({ executable, args, env: options.env });
    return { exitCode: executable === toolPaths.clamscan ? 1 : 0, stdout: "", stderr: "" };
  };
  const locked = new LockedNativeSupplyChainTools(policy, process);
  await assert.rejects(locked.validate({ agent: "claude-code", release, artifact, extractedRoot: extracted, workRoot: work }), (error) => {
    assert.ok(error instanceof NativePolicyViolation);
    assert.equal(error.failureCode, "MALWARE_DETECTED");
    return true;
  });
  assert.deepEqual(calls[0]?.args.slice(0, 3), ["--no-summary", "--infected", "--recursive"]);
  assert.equal(calls[0]?.env.PATH, "");
  assert.equal(calls[0]?.env.DISABLE_UPDATES, "1");

  const imageDigest = `sha256:${"f".repeat(64)}`;
  const buildCalls: Array<{ executable: string; args: readonly string[] }> = [];
  const buildProcess: NativeToolProcess = async (executable, args) => {
    buildCalls.push({ executable, args });
    if (executable === toolPaths.buildctl) {
      const metadataPath = args[args.indexOf("--metadata-file") + 1];
      assert.ok(metadataPath);
      await writeFile(metadataPath, JSON.stringify({ "containerimage.digest": imageDigest }));
    }
    if (executable === toolPaths.fleetctl) return {
      exitCode: 0,
      stdout: JSON.stringify({ installationId: "claude-installation-001", target: "dev-linux-workers", imageDigest, percent: 0, health: "READY" }),
      stderr: "",
    };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const buildRoot = join(root, "build"); await mkdir(buildRoot);
  const built = await new LockedNativeSupplyChainTools(policy, buildProcess).build({
    agent: "claude-code", version, installationId: "claude-installation-001", artifact,
    workerPool: "development-linux", adapterVersion: "1.3.0", workRoot: buildRoot,
  });
  assert.equal(built.imageDigest, imageDigest);
  const buildkit = buildCalls.find((call) => call.executable === toolPaths.buildctl);
  assert.match(buildkit?.args.find((arg) => arg.startsWith("type=image,name=")) ?? "", /claude-code:build-[a-f0-9]{32},push=true$/);
  assert.deepEqual(buildCalls.filter((call) => call.executable === toolPaths.cosign).map((call) => call.args[0]), ["sign", "verify"]);
  const registration = buildCalls.find((call) => call.executable === toolPaths.fleetctl);
  assert.ok(registration?.args.includes("register"));
  assert.ok(registration?.args.includes("dev-linux-workers"));
});

function policyFixture(): Record<string, unknown> {
  const tools = Object.fromEntries(NATIVE_POLICY_TOOL_IDS.map((id) => [id, {
    path: `/opt/deviludo/bin/${id}`, digest: "a".repeat(64), version: "1.0.0",
  }]));
  return {
    schemaVersion: "deviludo.agent-supply-chain-native-policy.v1",
    policyVersion: "1.0.0",
    officialRegistryOrigin: "https://registry.npmjs.org",
    trustedNpmKeyIds: [keyId],
    internalRegistryOrigin: "https://registry.deviludo.test",
    packageRepositoryPrefix: "agent-packages",
    imageRepositoryPrefix: "agent-workers",
    sbomRepositoryPrefix: "sboms",
    signingKeyRef: "kms://deviludo/agent-worker-signing",
    registryConfigDirectory: "/etc/deviludo/registry",
    scannerDataDirectory: "/var/lib/deviludo/scanners",
    fleetConfigFile: "/etc/deviludo/fleet.json",
    maxPackageBytes: 10 * 1024 * 1024,
    maxExtractedBytes: 20 * 1024 * 1024,
    tools,
    agents: {
      "claude-code": {
        packageName,
        workerBaseImage: `registry.deviludo.test/base/agent-worker@sha256:${"1".repeat(64)}`,
        validationHarnessImage: `registry.deviludo.test/harness/agent-contract@sha256:${"2".repeat(64)}`,
        adapterVersion: "1.3.0",
      },
      "codex-cli": {
        packageName: "@openai/codex",
        workerBaseImage: `registry.deviludo.test/base/agent-worker@sha256:${"1".repeat(64)}`,
        validationHarnessImage: `registry.deviludo.test/harness/agent-contract@sha256:${"2".repeat(64)}`,
        adapterVersion: "1.2.2",
      },
    },
    workerPools: [{ id: "development-linux", rolloutTarget: "dev-linux-workers" }],
  };
}

function transport(overrides: Readonly<{ signature?: string; download?: Buffer }> = {}): OfficialNpmTransport {
  return {
    async probe() {},
    async getJson(url) {
      if (url.pathname === "/-/npm/v1/keys") return { keys: [{ keyid: keyId, key: publicKeyDer, expires: null }] };
      if (url.pathname.endsWith(`/${version}`)) return {
        name: packageName, version,
        dist: {
          tarball: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`,
          integrity,
          signatures: [{ keyid: keyId, sig: overrides.signature ?? signature }],
        },
      };
      return { "dist-tags": { latest: version } };
    },
    async download(_url, destinationPath) {
      const value = overrides.download ?? archive;
      await writeFile(destinationPath, value, { flag: "wx", mode: 0o400 });
      return { path: destinationPath, sizeBytes: value.length, sha256: digest(value), sha512Base64: createHash("sha512").update(value).digest("base64") };
    },
  };
}

type TarEntry = Readonly<{ path: string; body?: Buffer; type?: "directory" | "symlink" }>;
function npmArchive(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    octal(header, 100, 8, entry.type === "directory" ? 0o755 : 0o644);
    octal(header, 108, 8, 0); octal(header, 116, 8, 0); octal(header, 124, 12, body.length); octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = entry.type === "directory" ? 53 : entry.type === "symlink" ? 50 : 48;
    header.write("ustar", 257, "ascii"); header[262] = 0; header.write("00", 263, "ascii");
    octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
function octal(target: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 2, "0");
  target.write(`${text}\0 `, offset, length, "ascii");
}
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
