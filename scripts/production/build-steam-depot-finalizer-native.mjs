#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const NODE_VERSION = /^v22\.(?<minor>\d+)\.(?<patch>\d+)$/;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const ESBUILD_INTEGRITY = "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==";
const POSTJECT_INTEGRITY = "sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==";
const ENTRY_POINT = "services/steam-depot-finalizer/src/native-main.ts";
const RECEIPT_FILE = "steam-depot-finalizer-native-build-receipt.json";

export function parseSteamDepotFinalizerNativeBuildArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 8) invalidInput();
  const values = new Map();
  const allowed = new Set(["--node-binary", "--node-binary-digest", "--output-directory", "--source-revision"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name)
      || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const options = {
    nodeBinary: values.get("--node-binary"),
    nodeBinaryDigest: values.get("--node-binary-digest"),
    outputDirectory: values.get("--output-directory"),
    sourceRevision: values.get("--source-revision"),
  };
  validateOptions(options);
  return Object.freeze(options);
}

export function validateSteamDepotFinalizerNativeBuildReceipt(value) {
  if (!plainRecord(value) || !exactKeys(value, [
    "architecture", "artifactDigest", "artifactFileName", "bundleDigest", "bundleInputCount", "completedAt",
    "esbuildBinaryDigest", "esbuildLibraryDigest", "esbuildVersion", "identityDigest", "nodeBinaryDigest",
    "nodeVersion", "packageLockDigest", "platform", "platformVersion", "postjectCliDigest", "postjectVersion",
    "schemaVersion", "signatureState", "sizeBytes", "sourceRevision", "status",
  ]) || value.schemaVersion !== "deviludo.steam-depot-finalizer-native-build-receipt.v1"
    || value.status !== "CANDIDATE" || !fixedVersion(value.platformVersion)
    || !SOURCE_REVISION.test(value.sourceRevision) || !new Set(["windows", "linux", "macos"]).has(value.platform)
    || !new Set(["x86_64", "arm64"]).has(value.architecture) || !NODE_VERSION.test(value.nodeVersion)
    || !SHA256.test(value.nodeBinaryDigest) || !SHA256.test(value.packageLockDigest)
    || value.esbuildVersion !== "0.28.0" || !SHA256.test(value.esbuildLibraryDigest)
    || !SHA256.test(value.esbuildBinaryDigest) || value.postjectVersion !== "1.0.0-alpha.6"
    || !SHA256.test(value.postjectCliDigest)
    || value.artifactFileName !== artifactFileName(value.platform) || !SHA256.test(value.artifactDigest)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_ARTIFACT_BYTES
    || !SHA256.test(value.bundleDigest) || !Number.isSafeInteger(value.bundleInputCount)
    || value.bundleInputCount < 1 || !SHA256.test(value.identityDigest) || !canonicalTimestamp(value.completedAt)
    || value.signatureState !== signatureState(value.platform)) invalidReceipt();
  return Object.freeze({ ...value });
}

export async function buildSteamDepotFinalizerNative(options, dependencies = {}) {
  validateOptions(options);
  const root = dependencies.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const execute = dependencies.execute ?? executeCapture;
  const bundle = dependencies.bundle ?? bundleController;
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const [packageJsonBytes, packageLockBytes] = await Promise.all([
    readFile(resolve(root, "package.json")), readFile(resolve(root, "package-lock.json")),
  ]);
  let packageJson; let packageLock;
  try { packageJson = JSON.parse(packageJsonBytes.toString("utf8")); packageLock = JSON.parse(packageLockBytes.toString("utf8")); }
  catch { invalidBuild(); }
  const [sourceHead, sourceStatus, nodeMetadata, packageLockDigest] = await Promise.all([
    execute({ command: "git", args: ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"] }),
    execute({ command: "git", args: ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"] }),
    fileMetadata(options.nodeBinary),
    digestFile(resolve(root, "package-lock.json")),
  ]);
  if (sourceHead.trim() !== options.sourceRevision || sourceStatus !== ""
    || nodeMetadata.digest !== options.nodeBinaryDigest) invalidBuild();
  const runtime = parseNodeRuntime(await execute({
    command: options.nodeBinary,
    args: ["-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,execPath:process.execPath})"],
  }));
  if (resolve(runtime.execPath) !== resolve(options.nodeBinary)
    || runtime.platform !== process.platform || runtime.arch !== process.arch) invalidBuild();
  const target = nativeTarget(runtime.platform, runtime.arch);
  const nodeMatch = NODE_VERSION.exec(runtime.version);
  if (!nodeMatch || Number(nodeMatch.groups.minor) < 13) invalidBuild();
  validateLockedBuild(packageJson, packageLock, runtimePackageName(runtime.platform, runtime.arch));

  const parent = await lstat(dirname(options.outputDirectory));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalidBuild();
  try { await lstat(options.outputDirectory); invalidBuild(); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = `${options.outputDirectory}.tmp-${uuid()}`;
  await mkdir(temporary, { mode: 0o700 });
  let published = false;
  try {
    const postjectCli = resolve(root, "node_modules/postject/dist/cli.js");
    const esbuildLibrary = resolve(root, "node_modules/esbuild/lib/main.js");
    const esbuildBinary = resolve(root, "node_modules", runtimePackageName(runtime.platform, runtime.arch),
      ...(runtime.platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"]));
    const [postject, esbuildLib, esbuildBin] = await Promise.all([
      fileMetadata(postjectCli), fileMetadata(esbuildLibrary), fileMetadata(esbuildBinary),
    ]);
    const fileName = artifactFileName(target.platform);
    const bundlePath = resolve(temporary, "controller.cjs");
    const blobPath = resolve(temporary, "controller.blob");
    const configPath = resolve(temporary, "controller.sea.json");
    const executablePath = resolve(temporary, fileName);
    const bundled = await bundle({
      root, outfile: bundlePath, platformVersion: packageJson.version, sourceRevision: options.sourceRevision,
    });
    await writeFile(configPath, `${JSON.stringify({
      main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
    })}\n`, { flag: "wx", mode: 0o400 });
    await execute({ command: options.nodeBinary, args: ["--experimental-sea-config", configPath] });
    await copyFile(options.nodeBinary, executablePath, 0);
    if (runtime.platform === "darwin") await execute({ command: "codesign", args: ["--remove-signature", executablePath] });
    await execute({
      command: options.nodeBinary,
      args: [postjectCli, executablePath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SEA_FUSE,
        ...(runtime.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])],
    });
    if (runtime.platform === "darwin") {
      await execute({ command: "codesign", args: ["--sign", "-", "--force", executablePath] });
    }
    if (runtime.platform !== "win32") await chmod(executablePath, 0o500);
    const [artifact, bundleMetadata, identityOutput] = await Promise.all([
      fileMetadata(executablePath), fileMetadata(bundlePath),
      execute({ command: executablePath, args: ["--identity"] }),
    ]);
    const identity = validateIdentity(JSON.parse(identityOutput), {
      platformVersion: packageJson.version, sourceRevision: options.sourceRevision, runtime,
    });
    const receipt = validateSteamDepotFinalizerNativeBuildReceipt({
      schemaVersion: "deviludo.steam-depot-finalizer-native-build-receipt.v1",
      status: "CANDIDATE",
      platformVersion: packageJson.version,
      sourceRevision: options.sourceRevision,
      platform: target.platform,
      architecture: target.architecture,
      nodeVersion: runtime.version,
      nodeBinaryDigest: options.nodeBinaryDigest,
      packageLockDigest,
      esbuildVersion: "0.28.0",
      esbuildLibraryDigest: esbuildLib.digest,
      esbuildBinaryDigest: esbuildBin.digest,
      postjectVersion: "1.0.0-alpha.6",
      postjectCliDigest: postject.digest,
      signatureState: signatureState(target.platform),
      artifactFileName: fileName,
      artifactDigest: artifact.digest,
      sizeBytes: artifact.sizeBytes,
      bundleDigest: bundleMetadata.digest,
      bundleInputCount: bundled.inputCount,
      identityDigest: sha256Canonical(identity),
      completedAt: canonicalDate(now()),
    });
    await writeFile(resolve(temporary, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx", mode: 0o400,
    });
    await Promise.all([rm(bundlePath), rm(blobPath), rm(configPath)]);
    await rename(temporary, options.outputDirectory);
    published = true;
    return Object.freeze({ ...receipt, outputDirectory: options.outputDirectory });
  } finally { if (!published) await rm(temporary, { recursive: true, force: true }); }
}

async function bundleController({ root, outfile, platformVersion, sourceRevision }) {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [resolve(root, ENTRY_POINT)], outfile, bundle: true, platform: "node", target: "node22.13",
    format: "cjs", packages: "bundle", legalComments: "none", sourcemap: false, minify: false,
    metafile: true, logLevel: "warning",
    define: {
      __DEVILUDO_NATIVE_PLATFORM_VERSION__: JSON.stringify(platformVersion),
      __DEVILUDO_NATIVE_SOURCE_REVISION__: JSON.stringify(sourceRevision),
      "import.meta.url": JSON.stringify("deviludo:steam-depot-finalizer-native"),
    },
  });
  return Object.freeze({ inputCount: Object.keys(result.metafile.inputs).length });
}

function validateLockedBuild(packageJson, packageLock, platformPackage) {
  const esbuild = packageLock?.packages?.["node_modules/esbuild"];
  const postject = packageLock?.packages?.["node_modules/postject"];
  const platform = packageLock?.packages?.[`node_modules/${platformPackage}`];
  if (!plainRecord(packageJson) || !fixedVersion(packageJson.version) || packageJson.devDependencies?.esbuild !== "0.28.0"
    || packageJson.devDependencies?.postject !== "1.0.0-alpha.6" || !plainRecord(esbuild)
    || esbuild.version !== "0.28.0" || esbuild.integrity !== ESBUILD_INTEGRITY
    || esbuild.resolved !== "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz"
    || !plainRecord(postject) || postject.version !== "1.0.0-alpha.6" || postject.integrity !== POSTJECT_INTEGRITY
    || postject.resolved !== "https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz"
    || !plainRecord(platform) || platform.version !== "0.28.0" || typeof platform.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(platform.integrity)) invalidBuild();
}

function validateIdentity(identity, expected) {
  if (!plainRecord(identity) || !exactKeys(identity, [
    "architecture", "component", "nodeVersion", "platform", "platformVersion", "schemaVersion", "sourceRevision",
  ]) || identity.schemaVersion !== "deviludo.native-component-identity.v1"
    || identity.component !== "steam-depot-finalizer-controller"
    || identity.platformVersion !== expected.platformVersion || identity.sourceRevision !== expected.sourceRevision
    || identity.nodeVersion !== expected.runtime.version || identity.platform !== expected.runtime.platform
    || identity.architecture !== expected.runtime.arch) invalidBuild();
  return Object.freeze({ ...identity });
}

function validateOptions(value) {
  if (!plainRecord(value) || !absolute(value.nodeBinary) || !SHA256.test(value.nodeBinaryDigest)
    || !absolute(value.outputDirectory) || !SOURCE_REVISION.test(value.sourceRevision)) invalidInput();
}
function parseNodeRuntime(output) {
  let value; try { value = JSON.parse(output); } catch { invalidBuild(); }
  if (!plainRecord(value) || !exactKeys(value, ["arch", "execPath", "platform", "version"])
    || typeof value.version !== "string" || typeof value.platform !== "string"
    || typeof value.arch !== "string" || !absolute(value.execPath)) invalidBuild();
  return Object.freeze(value);
}
function nativeTarget(platform, architecture) {
  const selectedPlatform = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
  const selectedArchitecture = architecture === "x64" ? "x86_64" : architecture;
  if (!new Set(["windows", "linux", "macos"]).has(selectedPlatform)
    || !new Set(["x86_64", "arm64"]).has(selectedArchitecture)) invalidBuild();
  return Object.freeze({ platform: selectedPlatform, architecture: selectedArchitecture });
}
function runtimePackageName(platform, architecture) {
  const packagePlatform = platform === "win32" ? "win32" : platform;
  if (!new Set(["darwin", "linux", "win32"]).has(packagePlatform)
    || !new Set(["x64", "arm64"]).has(architecture)) invalidBuild();
  return `@esbuild/${packagePlatform}-${architecture}`;
}
function artifactFileName(platform) { return `deviludo-steam-depot-finalizer-native${platform === "windows" ? ".exe" : ""}`; }
function signatureState(platform) {
  return platform === "macos" ? "ADHOC_BUILD_ONLY" : platform === "windows" ? "INVALIDATED_UPSTREAM_SIGNATURE" : "UNSIGNED";
}
async function executeCapture(invocation) {
  return new Promise((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { shell: false, stdio: ["ignore", "pipe", "inherit"] });
    const chunks = []; let length = 0;
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_CAPTURE_BYTES) child.kill("SIGKILL"); else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 && signal === null && length <= MAX_CAPTURE_BYTES
      ? accept(Buffer.concat(chunks).toString("utf8")) : reject(new Error("Native finalizer build command failed")));
  });
}
async function fileMetadata(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_ARTIFACT_BYTES) invalidBuild();
  const body = await readFile(path);
  return Object.freeze({ digest: createHash("sha256").update(body).digest("hex"), sizeBytes: body.length });
}
async function digestFile(path) { return (await fileMetadata(path)).digest; }
function sha256Canonical(value) { return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex"); }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (plainRecord(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonicalize(child)]));
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isSafeInteger(value)) return value;
  invalidBuild();
}
function canonicalDate(value) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalidBuild(); return value.toISOString(); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function fixedVersion(value) { return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) && !/(latest|stable|default)/i.test(value); }
function absolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalidInput() { throw new Error("Steam depot finalizer native build input is invalid"); }
function invalidBuild() { throw new Error("Steam depot finalizer native build failed validation"); }
function invalidReceipt() { throw new Error("Steam depot finalizer native build receipt is invalid"); }

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const receipt = await buildSteamDepotFinalizerNative(
    parseSteamDepotFinalizerNativeBuildArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[build:steam-depot-finalizer-native] build failed\n");
    process.exitCode = 1;
  });
}
