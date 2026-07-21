#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const NODE_VERSION = /^v22\.(?<minor>\d+)\.(?<patch>\d+)$/;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const ESBUILD_INTEGRITY = "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==";
const POSTJECT_INTEGRITY = "sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==";
const COMPONENTS = Object.freeze([
  Object.freeze({ component: "godot-testkit", entry: "services/godot-testkit/src/native-main.ts" }),
  Object.freeze({ component: "physical-runner", entry: "services/runner-control/src/native-main.ts" }),
  Object.freeze({ component: "steam-client-connector", entry: "services/steam-client-connector/src/native-main.ts" }),
]);

const FILE_NAMES = Object.freeze({
  "godot-testkit": "deviludo-testkit",
  "physical-runner": "deviludo-physical-runner",
  "steam-client-connector": "deviludo-steam-client-connector",
});

export function parseRunnerNativeBuildArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) invalidInput();
  const values = new Map();
  const allowed = new Set(["--node-binary", "--node-binary-digest", "--output-directory", "--source-revision"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalidInput();
    values.set(name, value);
  }
  const nodeBinary = values.get("--node-binary");
  const nodeBinaryDigest = values.get("--node-binary-digest");
  const outputDirectory = values.get("--output-directory");
  const sourceRevision = values.get("--source-revision");
  if (!absolute(nodeBinary) || !SHA256.test(nodeBinaryDigest) || !absolute(outputDirectory)
    || typeof sourceRevision !== "string" || !SOURCE_REVISION.test(sourceRevision)) invalidInput();
  return Object.freeze({ nodeBinary, nodeBinaryDigest, outputDirectory, sourceRevision });
}

export async function buildRunnerNativeCandidates(options, dependencies = {}) {
  validateBuildOptions(options);
  const root = dependencies.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const execute = dependencies.execute ?? executeCapture;
  const bundle = dependencies.bundle ?? bundleComponent;
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const packageLockPath = resolve(root, "package-lock.json");
  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.devDependencies?.esbuild !== "0.28.0"
    || packageJson.devDependencies?.postject !== "1.0.0-alpha.6") invalidBuild();
  validateLockedBuildPackages(packageLock, runtimePackageName(process.platform, process.arch));
  const [sourceHead, sourceStatus, nodeMetadata, packageLockDigest] = await Promise.all([
    execute(Object.freeze({ command: "git", args: Object.freeze(["-C", root, "rev-parse", "--verify", "HEAD^{commit}"]) })),
    execute(Object.freeze({ command: "git", args: Object.freeze(["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]) })),
    fileMetadata(options.nodeBinary),
    digestFile(packageLockPath),
  ]);
  if (sourceHead.trim() !== options.sourceRevision || sourceStatus !== "") invalidBuild();
  if (nodeMetadata.digest !== options.nodeBinaryDigest) invalidBuild();
  const runtime = parseNodeRuntime(await execute(Object.freeze({
    command: options.nodeBinary,
    args: Object.freeze(["-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,execPath:process.execPath})"]),
  }))); 
  if (resolve(runtime.execPath) !== resolve(options.nodeBinary)) invalidBuild();
  if (runtime.platform !== process.platform || runtime.arch !== process.arch) invalidBuild();
  const target = nativeTarget(runtime.platform, runtime.arch);
  const nodeMatch = NODE_VERSION.exec(runtime.version);
  if (!nodeMatch || Number(nodeMatch.groups.minor) < 13) invalidBuild();

  const parent = dirname(options.outputDirectory);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) invalidBuild();
  try { await lstat(options.outputDirectory); invalidBuild(); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryDirectory = `${options.outputDirectory}.tmp-${uuid()}`;
  if (!absolute(temporaryDirectory)) invalidBuild();
  await mkdir(temporaryDirectory, { mode: 0o700 });
  let published = false;
  try {
    const postjectCli = resolve(root, "node_modules/postject/dist/cli.js");
    const esbuildLibrary = resolve(root, "node_modules/esbuild/lib/main.js");
    const esbuildBinary = resolve(root, "node_modules", runtimePackageName(runtime.platform, runtime.arch),
      ...(runtime.platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"]));
    const [postjectMetadata, esbuildLibraryMetadata, esbuildBinaryMetadata] = await Promise.all([
      fileMetadata(postjectCli),
      fileMetadata(esbuildLibrary),
      fileMetadata(esbuildBinary),
    ]);
    const artifacts = [];
    for (const descriptor of COMPONENTS) {
      const extension = runtime.platform === "win32" ? ".exe" : "";
      const fileName = `${FILE_NAMES[descriptor.component]}${extension}`;
      const bundlePath = resolve(temporaryDirectory, `${descriptor.component}.cjs`);
      const blobPath = resolve(temporaryDirectory, `${descriptor.component}.blob`);
      const configPath = resolve(temporaryDirectory, `${descriptor.component}.sea.json`);
      const executablePath = resolve(temporaryDirectory, fileName);
      const bundleResult = await bundle({
        root,
        descriptor,
        outfile: bundlePath,
        platformVersion: packageJson.version,
        sourceRevision: options.sourceRevision,
      });
      await writeFile(configPath, `${JSON.stringify({
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      })}\n`, { flag: "wx", mode: 0o400 });
      await execute(Object.freeze({
        command: options.nodeBinary,
        args: Object.freeze(["--experimental-sea-config", configPath]),
      }));
      await copyFile(options.nodeBinary, executablePath, 0);
      if (runtime.platform === "darwin") {
        await execute(Object.freeze({ command: "codesign", args: Object.freeze(["--remove-signature", executablePath]) }));
      }
      await execute(Object.freeze({
        command: options.nodeBinary,
        args: Object.freeze([
          postjectCli,
          executablePath,
          "NODE_SEA_BLOB",
          blobPath,
          "--sentinel-fuse",
          SEA_FUSE,
          ...(runtime.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
        ]),
      }));
      if (runtime.platform === "darwin") {
        await execute(Object.freeze({ command: "codesign", args: Object.freeze(["--sign", "-", "--force", executablePath]) }));
      }
      if (runtime.platform !== "win32") await chmod(executablePath, 0o500);
      const [artifactMetadata, bundleMetadata, identityOutput] = await Promise.all([
        fileMetadata(executablePath),
        fileMetadata(bundlePath),
        execute(Object.freeze({ command: executablePath, args: Object.freeze(["--identity"]) })),
      ]);
      const identity = validateIdentity(JSON.parse(identityOutput), {
        component: descriptor.component,
        platformVersion: packageJson.version,
        sourceRevision: options.sourceRevision,
        runtime,
      });
      artifacts.push(Object.freeze({
        component: descriptor.component,
        fileName,
        candidateDigest: artifactMetadata.digest,
        sizeBytes: artifactMetadata.sizeBytes,
        bundleDigest: bundleMetadata.digest,
        bundleInputCount: bundleResult.inputCount,
        identityDigest: sha256Canonical(identity),
      }));
    }
    const receipt = Object.freeze({
      schemaVersion: "deviludo.runner-native-build-receipt.v2",
      status: "CANDIDATE",
      platformVersion: packageJson.version,
      sourceRevision: options.sourceRevision,
      platform: target.platform,
      architecture: target.architecture,
      nodeVersion: runtime.version,
      nodeBinaryDigest: options.nodeBinaryDigest,
      packageLockDigest,
      esbuildVersion: "0.28.0",
      esbuildLibraryDigest: esbuildLibraryMetadata.digest,
      esbuildBinaryDigest: esbuildBinaryMetadata.digest,
      postjectVersion: "1.0.0-alpha.6",
      postjectCliDigest: postjectMetadata.digest,
      signatureState: target.platform === "macos" ? "ADHOC_BUILD_ONLY"
        : target.platform === "windows" ? "INVALIDATED_UPSTREAM_SIGNATURE" : "UNSIGNED",
      completedAt: canonicalTimestamp(now()),
      artifacts: Object.freeze(artifacts.sort((left, right) => left.component.localeCompare(right.component))),
    });
    await writeFile(resolve(temporaryDirectory, "runner-native-build-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o400 });
    for (const descriptor of COMPONENTS) {
      await Promise.all([
        rm(resolve(temporaryDirectory, `${descriptor.component}.cjs`)),
        rm(resolve(temporaryDirectory, `${descriptor.component}.blob`)),
        rm(resolve(temporaryDirectory, `${descriptor.component}.sea.json`)),
      ]);
    }
    await rename(temporaryDirectory, options.outputDirectory);
    published = true;
    return Object.freeze({ ...receipt, outputDirectory: options.outputDirectory });
  } finally {
    if (!published) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function bundleComponent({ root, descriptor, outfile, platformVersion, sourceRevision }) {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [resolve(root, descriptor.entry)],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22.13",
    format: "cjs",
    packages: "bundle",
    legalComments: "none",
    sourcemap: false,
    minify: false,
    metafile: true,
    logLevel: "warning",
    define: {
      __DEVILUDO_NATIVE_PLATFORM_VERSION__: JSON.stringify(platformVersion),
      __DEVILUDO_NATIVE_SOURCE_REVISION__: JSON.stringify(sourceRevision),
      "import.meta.url": JSON.stringify("deviludo:native-bundle"),
    },
  });
  return Object.freeze({ inputCount: Object.keys(result.metafile.inputs).length });
}

function validateLockedBuildPackages(packageLock, platformPackage) {
  const esbuild = packageLock?.packages?.["node_modules/esbuild"];
  const postject = packageLock?.packages?.["node_modules/postject"];
  const platform = packageLock?.packages?.[`node_modules/${platformPackage}`];
  if (!plainRecord(esbuild) || esbuild.version !== "0.28.0" || esbuild.integrity !== ESBUILD_INTEGRITY
    || esbuild.resolved !== "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz"
    || !plainRecord(postject) || postject.version !== "1.0.0-alpha.6"
    || postject.integrity !== POSTJECT_INTEGRITY
    || postject.resolved !== "https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz"
    || !plainRecord(platform) || platform.version !== "0.28.0" || typeof platform.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(platform.integrity)) invalidBuild();
}

function runtimePackageName(platform, architecture) {
  const packagePlatform = platform === "win32" ? "win32" : platform;
  const packageArchitecture = architecture === "x64" ? "x64" : architecture;
  if (!new Set(["darwin", "linux", "win32"]).has(packagePlatform)
    || !new Set(["x64", "arm64"]).has(packageArchitecture)) invalidBuild();
  return `@esbuild/${packagePlatform}-${packageArchitecture}`;
}

function parseNodeRuntime(output) {
  let value;
  try { value = JSON.parse(output); } catch { invalidBuild(); }
  if (!plainRecord(value) || !exactKeys(value, ["arch", "execPath", "platform", "version"])
    || typeof value.version !== "string" || typeof value.platform !== "string"
    || typeof value.arch !== "string" || !absolute(value.execPath)) invalidBuild();
  return Object.freeze(value);
}

function nativeTarget(platform, architecture) {
  const targetPlatform = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
  const targetArchitecture = architecture === "x64" ? "x86_64" : architecture;
  if (!new Set(["windows", "linux", "macos"]).has(targetPlatform)
    || !new Set(["x86_64", "arm64"]).has(targetArchitecture)) invalidBuild();
  return Object.freeze({ platform: targetPlatform, architecture: targetArchitecture });
}

function validateIdentity(identity, expected) {
  if (!plainRecord(identity) || !exactKeys(identity, [
    "architecture", "component", "nodeVersion", "platform", "platformVersion", "schemaVersion", "sourceRevision",
  ]) || identity.schemaVersion !== "deviludo.native-component-identity.v1"
    || identity.component !== expected.component || identity.platformVersion !== expected.platformVersion
    || identity.sourceRevision !== expected.sourceRevision || identity.nodeVersion !== expected.runtime.version
    || identity.platform !== expected.runtime.platform || identity.architecture !== expected.runtime.arch) invalidBuild();
  return Object.freeze({ ...identity });
}

function validateBuildOptions(options) {
  if (!plainRecord(options) || !absolute(options.nodeBinary) || !SHA256.test(options.nodeBinaryDigest)
    || !absolute(options.outputDirectory) || typeof options.sourceRevision !== "string"
    || !SOURCE_REVISION.test(options.sourceRevision)) invalidInput();
}

function absolute(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096;
}

async function digestFile(path) {
  return (await fileMetadata(path)).digest;
}

async function fileMetadata(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1
    || metadata.size > MAX_ARTIFACT_BYTES) invalidBuild();
  const body = await readFile(path);
  return Object.freeze({
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    sizeBytes: body.length,
  });
}

async function executeCapture(invocation) {
  return new Promise((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { shell: false, stdio: ["ignore", "pipe", "inherit"] });
    const chunks = [];
    let length = 0;
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_CAPTURE_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null && length <= MAX_CAPTURE_BYTES) accept(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error("Native Runner build command failed"));
    });
  });
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (plainRecord(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isSafeInteger(value)) return value;
  invalidBuild();
}

function canonicalTimestamp(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) invalidBuild();
  return value.toISOString();
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidInput() {
  throw new Error("Runner native build input is invalid");
}

function invalidBuild() {
  throw new Error("Runner native build failed validation");
}

async function main() {
  if (process.env.NODE_ENV !== "production") invalidInput();
  const receipt = await buildRunnerNativeCandidates(parseRunnerNativeBuildArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("[build:runner-native] build failed\n");
    process.exitCode = 1;
  });
}
