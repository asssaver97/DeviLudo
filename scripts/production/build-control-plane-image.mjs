#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const PLATFORM = /^linux\/(amd64|arm64)$/;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OCI_REPOSITORY = "[a-z0-9][a-z0-9.-]*(?::[0-9]{2,5})?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+";
const DESTINATION = new RegExp(`^(?<repository>${OCI_REPOSITORY}):(?<tag>[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$`);
const BASE_IMAGE = new RegExp(`^(?<repository>${OCI_REPOSITORY}):22\\.(?<minor>\\d+)\\.(?<patch>\\d+)-(?:bookworm|trixie)-slim@sha256:(?<digest>[a-f0-9]{64})$`);
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export function validateControlPlaneImageSpec(input, packageVersion) {
  if (!input || typeof input !== "object" || !PACKAGE_VERSION.test(packageVersion)) invalid();
  const baseImage = input.baseImage;
  const destination = input.destination;
  const sourceRevision = input.sourceRevision;
  const platform = input.platform ?? "linux/amd64";
  const base = typeof baseImage === "string" ? BASE_IMAGE.exec(baseImage) : null;
  const target = typeof destination === "string" ? DESTINATION.exec(destination) : null;
  if (!base || !base.groups?.repository.endsWith("/node") || Number(base.groups.minor) < 13
    || !SOURCE_REVISION.test(sourceRevision)
    || !PLATFORM.test(platform) || !target) invalid();
  const expectedTag = `${packageVersion}-${sourceRevision.slice(0, 12)}`;
  if (target.groups?.tag !== expectedTag || target.groups.tag === "latest") invalid();
  return Object.freeze({ baseImage, destination, sourceRevision, platform, packageVersion });
}

export function controlPlaneBuildCommand(spec, metadataFile) {
  const validated = validateControlPlaneImageSpec(spec, spec?.packageVersion);
  if (typeof metadataFile !== "string" || !metadataFile.startsWith("/") || /[\0\r\n]/.test(metadataFile)) invalid();
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      "buildx", "build",
      "--file", "Dockerfile.control-plane",
      "--platform", validated.platform,
      "--build-arg", `NODE_BASE_IMAGE=${validated.baseImage}`,
      "--build-arg", `DEVILUDO_PLATFORM_VERSION=${validated.packageVersion}`,
      "--build-arg", `DEVILUDO_SOURCE_REVISION=${validated.sourceRevision}`,
      "--tag", validated.destination,
      "--metadata-file", metadataFile,
      "--provenance=mode=max",
      "--sbom=true",
      "--pull",
      "--no-cache",
      "--push",
      ".",
    ]),
  });
}

export function parseControlPlaneBuildMetadata(value) {
  const digest = value && typeof value === "object" ? value["containerimage.digest"] : undefined;
  if (typeof digest !== "string" || !IMAGE_DIGEST.test(digest)) {
    throw new Error("Control-plane image digest is missing from BuildKit metadata");
  }
  return digest;
}

export function controlPlaneImageReceipt(spec, metadata, inputs, completedAt = new Date().toISOString()) {
  const validated = validateControlPlaneImageSpec(spec, spec?.packageVersion);
  const imageDigest = parseControlPlaneBuildMetadata(metadata);
  if (!IMAGE_DIGEST.test(inputs?.dockerfileDigest) || !IMAGE_DIGEST.test(inputs?.packageLockDigest)
    || !Number.isFinite(Date.parse(completedAt))) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.control-plane-image-receipt.v1",
    imageReference: `${validated.destination.slice(0, validated.destination.lastIndexOf(":"))}@${imageDigest}`,
    imageDigest,
    baseImage: validated.baseImage,
    sourceRevision: validated.sourceRevision,
    platform: validated.platform,
    platformVersion: validated.packageVersion,
    dockerfileDigest: inputs.dockerfileDigest,
    packageLockDigest: inputs.packageLockDigest,
    attestations: Object.freeze(["buildkit-provenance-mode-max", "buildkit-sbom"]),
    completedAt,
  });
}

export function parseControlPlaneImageArguments(argv, packageVersion) {
  if (!Array.isArray(argv)) invalid();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--base-image", "--destination", "--source-revision", "--platform"]).has(name)
      || typeof value !== "string" || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  if (argv.length % 2 !== 0 || !values.has("--base-image") || !values.has("--destination")
    || !values.has("--source-revision")) invalid();
  return validateControlPlaneImageSpec({
    baseImage: values.get("--base-image"),
    destination: values.get("--destination"),
    sourceRevision: values.get("--source-revision"),
    platform: values.get("--platform") ?? "linux/amd64",
  }, packageVersion);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const spec = parseControlPlaneImageArguments(process.argv.slice(2), packageJson.version);
  const temporary = await mkdtemp(join(tmpdir(), "deviludo-control-image-"));
  const metadataFile = join(temporary, "metadata.json");
  try {
    const build = controlPlaneBuildCommand(spec, metadataFile);
    await run(build.command, build.args, root);
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    const receipt = controlPlaneImageReceipt(spec, metadata, {
      dockerfileDigest: await digestFile(resolve(root, "Dockerfile.control-plane")),
      packageLockDigest: await digestFile(resolve(root, "package-lock.json")),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function run(command, args, cwd) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) accept();
      else reject(new Error("Control-plane image build failed"));
    });
  });
}

async function digestFile(path) {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

function invalid() {
  throw new Error("Control-plane image build input is invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[image:build-control] build failed\n");
    process.exitCode = 1;
  });
}
