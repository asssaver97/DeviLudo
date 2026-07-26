#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export function validateSteamWorkflowExecutorImageSpec(input, platformVersion) {
  if (!plainRecord(input) || !fixedVersion(platformVersion)) invalid();
  const base = typeof input.baseImage === "string" ? NODE_BASE.exec(input.baseImage) : null;
  const destination = typeof input.destination === "string" ? DESTINATION.exec(input.destination) : null;
  const platform = input.platform ?? "linux/amd64";
  if (!base || !base.groups?.repository.endsWith("/node") || Number(base.groups.minor) < 15
    || !destination || !destination.groups?.repository.endsWith("/steam-workflow-executor")
    || !SOURCE_REVISION.test(input.sourceRevision) || !PLATFORM.test(platform)) invalid();
  const expectedTag = `${platformVersion}-${input.sourceRevision.slice(0, 12)}`;
  if (destination.groups.tag !== expectedTag || destination.groups.tag === "latest") invalid();
  return Object.freeze({
    baseImage: input.baseImage, destination: input.destination, platform, platformVersion, sourceRevision: input.sourceRevision,
  });
}

export function steamWorkflowExecutorImageBuildCommand(spec, metadataFile) {
  const value = validateSteamWorkflowExecutorImageSpec(spec, spec?.platformVersion);
  if (typeof metadataFile !== "string" || !metadataFile.startsWith("/") || /[\0\r\n]/.test(metadataFile)) invalid();
  return Object.freeze({ command: "docker", args: Object.freeze([
    "buildx", "build", "--file", "Dockerfile.steam-workflow-executor", "--platform", value.platform,
    "--build-arg", `NODE_BASE_IMAGE=${value.baseImage}`,
    "--build-arg", `DEVILUDO_PLATFORM_VERSION=${value.platformVersion}`,
    "--build-arg", `DEVILUDO_SOURCE_REVISION=${value.sourceRevision}`,
    "--tag", value.destination, "--metadata-file", metadataFile,
    "--provenance=mode=max", "--sbom=true", "--pull", "--no-cache", "--push", ".",
  ]) });
}

export function parseSteamWorkflowExecutorImageBuildMetadata(value) {
  const digest = plainRecord(value) ? value["containerimage.digest"] : undefined;
  if (typeof digest !== "string" || !IMAGE_DIGEST.test(digest)) {
    throw new Error("Steam workflow executor image digest is missing from BuildKit metadata");
  }
  return digest;
}

export function steamWorkflowExecutorImageReceipt(spec, metadata, inputs, completedAt = new Date().toISOString()) {
  const value = validateSteamWorkflowExecutorImageSpec(spec, spec?.platformVersion);
  const imageDigest = parseSteamWorkflowExecutorImageBuildMetadata(metadata);
  if (!IMAGE_DIGEST.test(inputs?.dockerfileDigest) || !IMAGE_DIGEST.test(inputs?.packageLockDigest)
    || !canonicalTimestamp(completedAt)) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.steam-workflow-executor-image-receipt.v1",
    imageReference: `${value.destination.slice(0, value.destination.lastIndexOf(":"))}@${imageDigest}`,
    imageDigest,
    baseImage: value.baseImage,
    sourceRevision: value.sourceRevision,
    platform: value.platform,
    platformVersion: value.platformVersion,
    dockerfileDigest: inputs.dockerfileDigest,
    packageLockDigest: inputs.packageLockDigest,
    attestations: Object.freeze(["buildkit-provenance-mode-max", "buildkit-sbom"]),
    completedAt,
  });
}

export function validateSteamWorkflowExecutorImageReceipt(receipt, expected) {
  const base = typeof receipt?.baseImage === "string" ? NODE_BASE.exec(receipt.baseImage) : null;
  if (!plainRecord(receipt) || !exactKeys(receipt, [
    "schemaVersion", "imageReference", "imageDigest", "baseImage", "sourceRevision", "platform", "platformVersion",
    "dockerfileDigest", "packageLockDigest", "attestations", "completedAt",
  ]) || receipt.schemaVersion !== "deviludo.steam-workflow-executor-image-receipt.v1"
    || !fixedVersion(receipt.platformVersion) || !SOURCE_REVISION.test(receipt.sourceRevision) || !PLATFORM.test(receipt.platform)
    || !IMAGE_DIGEST.test(receipt.imageDigest) || typeof receipt.imageReference !== "string"
    || !receipt.imageReference.endsWith(`@${receipt.imageDigest}`)
    || !base || !base.groups?.repository.endsWith("/node") || Number(base.groups.minor) < 15
    || !IMAGE_DIGEST.test(receipt.dockerfileDigest) || !IMAGE_DIGEST.test(receipt.packageLockDigest)
    || JSON.stringify(receipt.attestations) !== JSON.stringify(["buildkit-provenance-mode-max", "buildkit-sbom"])
    || !canonicalTimestamp(receipt.completedAt) || !plainRecord(expected)
    || receipt.platformVersion !== expected.platformVersion || receipt.dockerfileDigest !== expected.dockerfileDigest
    || receipt.packageLockDigest !== expected.packageLockDigest
    || (expected.baseImage !== undefined && receipt.baseImage !== expected.baseImage)
    || (expected.sourceRevision !== undefined && receipt.sourceRevision !== expected.sourceRevision)
    || (expected.platform !== undefined && receipt.platform !== expected.platform)) invalidReceipt();
  const reference = receipt.imageReference.slice(0, -receipt.imageDigest.length - 1);
  if (!new RegExp(`^${OCI_REPOSITORY}$`).test(reference) || !reference.endsWith("/steam-workflow-executor")) invalidReceipt();
  return Object.freeze({ ...receipt, attestations: Object.freeze([...receipt.attestations]) });
}

export function parseSteamWorkflowExecutorImageArguments(argv, platformVersion) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) invalid();
  const allowed = new Set(["--base-image", "--destination", "--source-revision", "--platform"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (!["--base-image", "--destination", "--source-revision"].every((name) => values.has(name))) invalid();
  return validateSteamWorkflowExecutorImageSpec({
    baseImage: values.get("--base-image"), destination: values.get("--destination"),
    sourceRevision: values.get("--source-revision"), platform: values.get("--platform") ?? "linux/amd64",
  }, platformVersion);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const spec = parseSteamWorkflowExecutorImageArguments(process.argv.slice(2), packageJson.version);
  const temporary = await mkdtemp(join(tmpdir(), "deviludo-steam-workflow-executor-image-"));
  const metadataFile = join(temporary, "metadata.json");
  try {
    const build = steamWorkflowExecutorImageBuildCommand(spec, metadataFile);
    await run(build.command, build.args, root);
    const receipt = steamWorkflowExecutorImageReceipt(spec, JSON.parse(await readFile(metadataFile, "utf8")), {
      dockerfileDigest: await digestFile(resolve(root, "Dockerfile.steam-workflow-executor")),
      packageLockDigest: await digestFile(resolve(root, "package-lock.json")),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
function run(command, args, cwd) { return new Promise((accept, reject) => {
  const child = spawn(command, args, { cwd, shell: false, stdio: "inherit" });
  child.once("error", reject); child.once("exit", (code, signal) => code === 0 && signal === null
    ? accept() : reject(new Error("Steam workflow executor image build failed")));
}); }
async function digestFile(path) { return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`; }
function fixedVersion(value) { return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Steam workflow executor image build input is invalid"); }
function invalidReceipt() { throw new Error("Steam workflow executor image receipt is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[image:build-steam-workflow-executor] build failed\n"); process.exitCode = 1; });
}
