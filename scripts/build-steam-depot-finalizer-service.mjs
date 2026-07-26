#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const SOURCE_REVISION = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ESBUILD_INTEGRITY = "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==";
const ARTIFACT_FILE = "deviludo-steam-depot-finalizer-service.mjs";
const RECEIPT_FILE = "steam-depot-finalizer-service-build-receipt.json";

export function parseSteamDepotFinalizerServiceBuildArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) invalid();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!new Set(["--source-revision", "--output-directory"]).has(name)
      || typeof value !== "string" || !value || values.has(name) || /[\0\r\n]/.test(value)) invalid();
    values.set(name, value);
  }
  const sourceRevision = values.get("--source-revision");
  const outputDirectory = values.get("--output-directory");
  if (!SOURCE_REVISION.test(sourceRevision) || !absolute(outputDirectory)) invalid();
  return Object.freeze({ outputDirectory, sourceRevision });
}

export function validateSteamDepotFinalizerServiceBuildReceipt(value) {
  if (!plainRecord(value) || !exactKeys(value, [
    "schemaVersion", "status", "platformVersion", "sourceRevision", "nodeTarget", "packageLockDigest",
    "esbuildVersion", "esbuildLibraryDigest", "entryPoint", "artifactFileName", "artifactDigest", "sizeBytes",
    "bundleInputCount", "bundleInputDigest", "completedAt",
  ]) || value.schemaVersion !== "deviludo.steam-depot-finalizer-service-build-receipt.v1" || value.status !== "CANDIDATE"
    || !fixedVersion(value.platformVersion) || !SOURCE_REVISION.test(value.sourceRevision) || value.nodeTarget !== "22.13"
    || !digest(value.packageLockDigest) || value.esbuildVersion !== "0.28.0" || !digest(value.esbuildLibraryDigest)
    || value.entryPoint !== "services/steam-depot-finalizer/src/run-native-bundle.ts"
    || value.artifactFileName !== ARTIFACT_FILE || !digest(value.artifactDigest)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 1024 * 1024 * 1024
    || !Number.isSafeInteger(value.bundleInputCount) || value.bundleInputCount < 1 || !digest(value.bundleInputDigest)
    || !canonicalTimestamp(value.completedAt)) invalidReceipt();
  return Object.freeze({ ...value });
}

export async function buildSteamDepotFinalizerService(options, {
  root = resolve("."), bundle = esbuild, now = () => new Date(), verifySource = verifyGitSource, uuid = randomUUID,
} = {}) {
  if (!plainRecord(options) || !SOURCE_REVISION.test(options.sourceRevision) || !absolute(options.outputDirectory)
    || !absolute(root) || typeof bundle !== "function" || typeof verifySource !== "function" || typeof uuid !== "function") invalid();
  await verifySource(root, options.sourceRevision);
  const parent = await lstat(dirname(options.outputDirectory));
  if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  try { await lstat(options.outputDirectory); invalid(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const [packageJsonBytes, packageLockBytes, esbuildLibraryBytes] = await Promise.all([
    readFile(resolve(root, "package.json")), readFile(resolve(root, "package-lock.json")),
    readFile(resolve(root, "node_modules/esbuild/lib/main.js")),
  ]);
  let packageJson; let packageLock;
  try { packageJson = JSON.parse(packageJsonBytes.toString("utf8")); packageLock = JSON.parse(packageLockBytes.toString("utf8")); }
  catch { invalid(); }
  validateLockedBuild(packageJson, packageLock);
  const temporary = await mkdtemp(resolve(dirname(options.outputDirectory), `.steam-depot-finalizer-service-${uuid()}-`));
  let published = false;
  try {
    const artifactPath = resolve(temporary, ARTIFACT_FILE);
    const result = await bundle({
      entryPoints: [resolve(root, "services/steam-depot-finalizer/src/run-native-bundle.ts")],
      outfile: artifactPath,
      bundle: true,
      platform: "node",
      target: "node22.13",
      format: "esm",
      packages: "bundle",
      banner: { js: "#!/usr/bin/node\nimport { createRequire as __deviludoCreateRequire } from 'node:module'; const require = __deviludoCreateRequire(import.meta.url); globalThis.__DEVILUDO_STEAM_DEPOT_FINALIZER_BUNDLE__ = true;" },
      legalComments: "none",
      sourcemap: false,
      minify: false,
      metafile: true,
      logLevel: "warning",
    });
    await chmod(artifactPath, 0o500);
    const artifact = await readFile(artifactPath);
    const inputs = Object.keys(result.metafile?.inputs ?? {}).sort();
    const completedAt = now();
    if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime()) || inputs.length < 1) invalid();
    const receipt = validateSteamDepotFinalizerServiceBuildReceipt({
      schemaVersion: "deviludo.steam-depot-finalizer-service-build-receipt.v1",
      status: "CANDIDATE",
      platformVersion: packageJson.version,
      sourceRevision: options.sourceRevision,
      nodeTarget: "22.13",
      packageLockDigest: hash(packageLockBytes),
      esbuildVersion: "0.28.0",
      esbuildLibraryDigest: hash(esbuildLibraryBytes),
      entryPoint: "services/steam-depot-finalizer/src/run-native-bundle.ts",
      artifactFileName: ARTIFACT_FILE,
      artifactDigest: hash(artifact),
      sizeBytes: artifact.byteLength,
      bundleInputCount: inputs.length,
      bundleInputDigest: hash(Buffer.from(JSON.stringify(inputs))),
      completedAt: completedAt.toISOString(),
    });
    await writeFile(resolve(temporary, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o400 });
    await rename(temporary, options.outputDirectory);
    published = true;
    return Object.freeze({ ...receipt, outputDirectory: options.outputDirectory });
  } finally { if (!published) await rm(temporary, { recursive: true, force: true }); }
}

async function verifyGitSource(root, sourceRevision) {
  const [head, status] = await Promise.all([
    capture("git", ["-C", root, "rev-parse", "HEAD"]),
    capture("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"]),
  ]);
  if (head.trim() !== sourceRevision || status.trim()) invalid();
}
function capture(command, args) {
  return new Promise((accept, reject) => execFile(command, args, {
    encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  }, (error, stdout) => error ? reject(error) : accept(stdout)));
}
function validateLockedBuild(packageJson, packageLock) {
  const locked = packageLock?.packages?.["node_modules/esbuild"];
  if (!plainRecord(packageJson) || !fixedVersion(packageJson.version) || packageJson.devDependencies?.esbuild !== "0.28.0"
    || !plainRecord(locked) || locked.version !== "0.28.0"
    || locked.resolved !== "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz"
    || locked.integrity !== ESBUILD_INTEGRITY) invalid();
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function digest(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function fixedVersion(value) { return typeof value === "string" && VERSION.test(value) && !/(?:latest|stable|default)/i.test(value); }
function canonicalTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function absolute(value) { return typeof value === "string" && isAbsolute(value) && resolve(value) === value && value.length <= 4_096; }
function exactKeys(value, expected) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function plainRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function invalid() { throw new Error("Steam depot finalizer service build input is invalid"); }
function invalidReceipt() { throw new Error("Steam depot finalizer service build receipt is invalid"); }

async function main() {
  const result = await buildSteamDepotFinalizerService(parseSteamDepotFinalizerServiceBuildArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("[build:steam-depot-finalizer-service] build failed\n"); process.exitCode = 1; });
}
