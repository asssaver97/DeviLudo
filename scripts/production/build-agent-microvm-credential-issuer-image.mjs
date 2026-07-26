#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const PLATFORM = /^linux\/(amd64|arm64)$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OCI_REPOSITORY = "[a-z0-9][a-z0-9.-]*(?::[0-9]{2,5})?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+";
const DESTINATION = new RegExp(`^(?<repository>${OCI_REPOSITORY}):(?<tag>[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$`);
const NODE_BASE = new RegExp(`^(?<repository>${OCI_REPOSITORY}):22\\.(?<minor>\\d+)\\.(?<patch>\\d+)-(?:bookworm|trixie)-slim@sha256:(?<digest>[a-f0-9]{64})$`);
const TOOLCHAIN_BASE = new RegExp(`^(?<repository>${OCI_REPOSITORY}):(?<version>\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)@sha256:(?<digest>[a-f0-9]{64})$`);
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export function validateAgentMicrovmCredentialIssuerImageSpec(input, platformVersion) {
  if (!plainRecord(input) || !fixedVersion(platformVersion)) invalid();
  const node = typeof input.nodeBaseImage === "string" ? NODE_BASE.exec(input.nodeBaseImage) : null;
  const toolchain = typeof input.toolchainBaseImage === "string" ? TOOLCHAIN_BASE.exec(input.toolchainBaseImage) : null;
  const destination = typeof input.destination === "string" ? DESTINATION.exec(input.destination) : null;
  const platform = input.platform ?? "linux/amd64";
  if (!node || !node.groups?.repository.endsWith("/node") || Number(node.groups.minor) < 13
    || !toolchain || !toolchain.groups?.repository.endsWith("/agent-microvm-credential-toolchain")
    || !fixedVersion(toolchain.groups.version) || toolchain.groups.version !== platformVersion
    || !destination || !destination.groups?.repository.endsWith("/agent-microvm-credential-issuer")
    || !SOURCE_REVISION.test(input.sourceRevision) || !PLATFORM.test(platform)) invalid();
  const expectedTag = `${platformVersion}-${input.sourceRevision.slice(0, 12)}`;
  if (destination.groups?.tag !== expectedTag || destination.groups.tag === "latest") invalid();
  return Object.freeze({
    destination: input.destination,
    nodeBaseImage: input.nodeBaseImage,
    platform,
    platformVersion,
    sourceRevision: input.sourceRevision,
    toolchainBaseImage: input.toolchainBaseImage,
  });
}

export function agentMicrovmCredentialIssuerImageBuildCommand(spec, metadataFile) {
  const value = validateAgentMicrovmCredentialIssuerImageSpec(spec, spec?.platformVersion);
  if (typeof metadataFile !== "string" || !metadataFile.startsWith("/") || /[\0\r\n]/.test(metadataFile)) invalid();
  return Object.freeze({ command: "docker", args: Object.freeze([
    "buildx", "build",
    "--file", "Dockerfile.agent-microvm-credential-issuer",
    "--platform", value.platform,
    "--build-arg", `NODE_BASE_IMAGE=${value.nodeBaseImage}`,
    "--build-arg", `TOOLCHAIN_BASE_IMAGE=${value.toolchainBaseImage}`,
    "--build-arg", `DEVILUDO_PLATFORM_VERSION=${value.platformVersion}`,
    "--build-arg", `DEVILUDO_SOURCE_REVISION=${value.sourceRevision}`,
    "--tag", value.destination,
    "--metadata-file", metadataFile,
    "--provenance=mode=max", "--sbom=true", "--pull", "--no-cache", "--push", ".",
  ]) });
}

export function agentMicrovmCredentialIssuerImageReceipt(spec, metadata, inputs, completedAt = new Date().toISOString()) {
  const value = validateAgentMicrovmCredentialIssuerImageSpec(spec, spec?.platformVersion);
  const imageDigest = parseBuildMetadata(metadata);
  if (!IMAGE_DIGEST.test(inputs?.dockerfileDigest) || !IMAGE_DIGEST.test(inputs?.packageLockDigest)
    || !canonicalTimestamp(completedAt)) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.agent-microvm-credential-issuer-image-receipt.v1",
    imageReference: `${value.destination.slice(0, value.destination.lastIndexOf(":"))}@${imageDigest}`,
    imageDigest,
    nodeBaseImage: value.nodeBaseImage,
    toolchainBaseImage: value.toolchainBaseImage,
    sourceRevision: value.sourceRevision,
    platform: value.platform,
    platformVersion: value.platformVersion,
    dockerfileDigest: inputs.dockerfileDigest,
    packageLockDigest: inputs.packageLockDigest,
    attestations: Object.freeze(["buildkit-provenance-mode-max", "buildkit-sbom"]),
    completedAt,
  });
}

export function validateAgentMicrovmCredentialIssuerImageReceipt(receipt, expected) {
  const node = typeof receipt?.nodeBaseImage === "string" ? NODE_BASE.exec(receipt.nodeBaseImage) : null;
  const toolchain = typeof receipt?.toolchainBaseImage === "string" ? TOOLCHAIN_BASE.exec(receipt.toolchainBaseImage) : null;
  if (!plainRecord(receipt) || !exactKeys(receipt, [
    "schemaVersion", "imageReference", "imageDigest", "nodeBaseImage", "toolchainBaseImage", "sourceRevision",
    "platform", "platformVersion", "dockerfileDigest", "packageLockDigest", "attestations", "completedAt",
  ]) || receipt.schemaVersion !== "deviludo.agent-microvm-credential-issuer-image-receipt.v1"
    || typeof receipt.platformVersion !== "string" || !fixedVersion(receipt.platformVersion)
    || !SOURCE_REVISION.test(receipt.sourceRevision) || !PLATFORM.test(receipt.platform)
    || !IMAGE_DIGEST.test(receipt.imageDigest) || typeof receipt.imageReference !== "string"
    || !receipt.imageReference.endsWith(`@${receipt.imageDigest}`)
    || !node || !node.groups?.repository.endsWith("/node") || Number(node.groups.minor) < 13
    || !toolchain || !toolchain.groups?.repository.endsWith("/agent-microvm-credential-toolchain")
    || toolchain.groups.version !== receipt.platformVersion
    || !IMAGE_DIGEST.test(receipt.dockerfileDigest) || !IMAGE_DIGEST.test(receipt.packageLockDigest)
    || JSON.stringify(receipt.attestations) !== JSON.stringify(["buildkit-provenance-mode-max", "buildkit-sbom"])
    || !canonicalTimestamp(receipt.completedAt) || !plainRecord(expected)
    || receipt.platformVersion !== expected.platformVersion || receipt.dockerfileDigest !== expected.dockerfileDigest
    || receipt.packageLockDigest !== expected.packageLockDigest
    || (expected.nodeBaseImage !== undefined && receipt.nodeBaseImage !== expected.nodeBaseImage)
    || (expected.toolchainBaseImage !== undefined && receipt.toolchainBaseImage !== expected.toolchainBaseImage)
    || (expected.sourceRevision !== undefined && receipt.sourceRevision !== expected.sourceRevision)
    || (expected.platform !== undefined && receipt.platform !== expected.platform)) invalidReceipt();
  const reference = receipt.imageReference.slice(0, -receipt.imageDigest.length - 1);
  if (!new RegExp(`^${OCI_REPOSITORY}$`).test(reference)
    || !reference.endsWith("/agent-microvm-credential-issuer")) invalidReceipt();
  return Object.freeze({ ...receipt, attestations: Object.freeze([...receipt.attestations]) });
}

export function parseAgentMicrovmCredentialIssuerImageArguments(argv, platformVersion) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) invalid();
  const allowed = new Set(["--node-base-image", "--toolchain-base-image", "--destination", "--source-revision", "--platform"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!["--node-base-image", "--toolchain-base-image", "--destination", "--source-revision"].every((name) => values.has(name))) invalid();
  return validateAgentMicrovmCredentialIssuerImageSpec({
    nodeBaseImage: values.get("--node-base-image"),
    toolchainBaseImage: values.get("--toolchain-base-image"),
    destination: values.get("--destination"),
    sourceRevision: values.get("--source-revision"),
    platform: values.get("--platform") ?? "linux/amd64",
  }, platformVersion);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const spec = parseAgentMicrovmCredentialIssuerImageArguments(process.argv.slice(2), packageJson.version);
  const temporary = await mkdtemp(join(tmpdir(), "deviludo-agent-microvm-credential-issuer-image-"));
  const metadataFile = join(temporary, "metadata.json");
  try {
    const build = agentMicrovmCredentialIssuerImageBuildCommand(spec, metadataFile);
    await run(build.command, build.args, root);
    const receipt = agentMicrovmCredentialIssuerImageReceipt(spec,
      JSON.parse(await readFile(metadataFile, "utf8")), {
        dockerfileDigest: await digestFile(resolve(root, "Dockerfile.agent-microvm-credential-issuer")),
        packageLockDigest: await digestFile(resolve(root, "package-lock.json")),
      });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function parseBuildMetadata(value) {
  const digest = plainRecord(value) ? value["containerimage.digest"] : undefined;
  if (typeof digest !== "string" || !IMAGE_DIGEST.test(digest)) {
    throw new Error("Agent microVM credential issuer image digest is missing from BuildKit metadata");
  }
  return digest;
}
function run(command, args, cwd) { return new Promise((accept, reject) => {
  const child = spawn(command, args, { cwd, shell: false, stdio: "inherit" });
  child.once("error", reject); child.once("exit", (code, signal) => code === 0 && signal === null
    ? accept() : reject(new Error("Agent microVM credential issuer image build failed")));
}); }
async function digestFile(path) { return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`; }
function fixedVersion(value) { return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Agent microVM credential issuer image build input is invalid"); }
function invalidReceipt() { throw new Error("Agent microVM credential issuer image receipt is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[image:build-agent-microvm-credential-issuer] build failed\n"); process.exitCode = 1; });
}
