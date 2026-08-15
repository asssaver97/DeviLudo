#!/usr/bin/env node
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function enrollRemoteE2e(arguments_) {
const options = parseOptions(arguments_);
const coreUrl = new URL(required(options, "core-url"));
const tokenFileInput = required(options, "enrollment-token-file");
const runtimeImageFileInput = required(options, "runtime-image-file");
const credentialDirectoryInput = required(options, "credential-directory");
if (![tokenFileInput, runtimeImageFileInput, credentialDirectoryInput].every(isAbsolute)) {
  throw new Error("Enrollment, runtime image, and credential paths must be absolute");
}
const tokenFile = resolve(tokenFileInput);
const runtimeImageFile = resolve(runtimeImageFileInput);
const credentialDirectory = resolve(credentialDirectoryInput);
const platform = required(options, "platform");
if (!(["windows", "linux", "macos"]).includes(platform)) throw new Error("--platform must be windows, linux, or macos");
assertSafeCoreUrl(coreUrl);
const poolKind = `E2E_${platform.toUpperCase()}`;
const token = (await readFile(tokenFile, "utf8")).trim();
if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new Error("Enrollment token file is invalid");
await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
const identityKeyFile = join(credentialDirectory, "receipt-ed25519.pem");
const identityPublicFile = join(credentialDirectory, "receipt-ed25519.pub");
const nodeAuthTokenFile = join(credentialDirectory, "node-auth-token");
let receiptPublicKey;
try {
  receiptPublicKey = await readFile(identityPublicFile, "utf8");
  await readFile(identityKeyFile, "utf8");
} catch {
  const pair = generateKeyPairSync("ed25519");
  await writeFile(identityKeyFile, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  receiptPublicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  await writeFile(identityPublicFile, receiptPublicKey, { mode: 0o644, flag: "wx" });
}
await chmod(identityKeyFile, 0o600);
let nodeAuthToken;
try {
  nodeAuthToken = (await readFile(nodeAuthTokenFile, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(nodeAuthToken)) throw new Error("invalid stored node token");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
  nodeAuthToken = randomBytes(32).toString("base64url");
  await writeFile(nodeAuthTokenFile, `${nodeAuthToken}\n`, { mode: 0o600, flag: "wx" });
}
await chmod(nodeAuthTokenFile, 0o600);
const nodeAuthTokenHash = `sha256:${createHash("sha256").update(nodeAuthToken, "utf8").digest("hex")}`;
const runtimeImage = `sha256:${await sha256File(runtimeImageFile)}`;
const response = await fetch(new URL("/v1/e2e/enroll-development", coreUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token, poolKind, operatingSystem: platform, receiptPublicKey, nodeAuthTokenHash, runtimeImage }),
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`Core enrollment returned ${response.status}: ${JSON.stringify(body).slice(0, 1_000)}`);
if (!/^[0-9a-f-]{36}$/i.test(body.nodeId ?? "")) throw new Error("Core returned an invalid node identity");
const configuration = Object.freeze({
  nodeId: body.nodeId,
  poolKind,
  operatingSystem: platform,
  coreUrl: coreUrl.href.replace(/\/$/, ""),
  token: nodeAuthToken,
  identityKeyFile,
  runtimeImage,
  runtimeImageFile,
});
await writeFile(join(credentialDirectory, "node.json"), `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
await chmod(join(credentialDirectory, "node.json"), 0o600);
return Object.freeze({ enrolled: true, ...configuration, token: "***" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  enrollRemoteE2e(process.argv.slice(2))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

function parseOptions(arguments_) {
  const parsed = Object.create(null);
  for (let index = 0; index < arguments_.length; index += 1) {
    const item = arguments_[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const separator = item.indexOf("=");
    if (separator > 2) parsed[item.slice(2, separator)] = item.slice(separator + 1);
    else {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${item} requires a value`);
      parsed[item.slice(2)] = value;
      index += 1;
    }
  }
  return parsed;
}

function required(options_, key) {
  const value = options_[key]?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function assertSafeCoreUrl(url) {
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Core URL is invalid");
  }
  if (url.protocol === "https:") return;
  if (isIP(url.hostname) !== 4 || !isPrivateIpv4(url.hostname)) {
    throw new Error("Plain HTTP enrollment is restricted to a private LAN/VPN IPv4 address");
  }
}

function isPrivateIpv4(value) {
  const [first, second] = value.split(".").map(Number);
  return first === 127
    || first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", chunk => hash.update(chunk));
    input.once("error", rejectPromise);
    input.once("end", () => resolvePromise(hash.digest("hex")));
  });
}
