import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const KEY_PATTERN = /^[A-Za-z0-9_-]{43,86}$/;
const OWNER_SCHEMA = "deviludo.local-sidecar-session.v1";
const OWNER_FIELDS = Object.freeze(["createdAt", "deploymentId", "pid", "schema"]);
const DEFAULT_STALE_AFTER_MS = 5_000;

/**
 * Claims one launcher identity before installing its three keys. A dead owner
 * may be replaced atomically, but legacy key files are reclaimed only after a
 * safety window. The owner record contains no key material.
 */
export async function installLocalSidecarSession({
  credentials,
  ownerFile,
  processId = process.pid,
  now = () => Date.now(),
  isProcessAlive = processIsAlive,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}) {
  validateCredentials(credentials);
  validateSessionOptions({ ownerFile, processId, now, isProcessAlive, staleAfterMs }, credentials);
  const deploymentId = randomBytes(24).toString("base64url");
  const createdAtMs = now();
  if (!Number.isFinite(createdAtMs)) throw new Error("Local deployment clock is invalid");
  const owner = Object.freeze({
    schema: OWNER_SCHEMA,
    deploymentId,
    pid: processId,
    createdAt: new Date(createdAtMs).toISOString(),
  });
  await claimOwner(ownerFile, owner, isProcessAlive);
  try {
    await removeStaleCredentials(credentials, createdAtMs, staleAfterMs);
    const removeCredentials = await installLocalSidecarCredentials(credentials);
    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      let failure;
      try { removeCredentials(); } catch (error) { failure = error; }
      try { removeOwnerIfOwned(ownerFile, deploymentId); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    };
    return Object.freeze({ cleanup, deploymentId, ownerFile });
  } catch (error) {
    removeOwnerIfOwned(ownerFile, deploymentId);
    throw error;
  }
}

/**
 * Atomically claims the local sidecar key files for one launcher. The returned
 * cleanup function owns only files created by this invocation, so a second
 * failed launcher can never delete credentials belonging to a running site.
 */
export async function installLocalSidecarCredentials(credentials) {
  validateCredentials(credentials);
  const ownedFiles = [];
  try {
    for (const credential of credentials) {
      const handle = await open(
        credential.file,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      ownedFiles.push(credential.file);
      try {
        await handle.writeFile(`${credential.key}\n`, "utf8");
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    await removeOwnedFiles(ownedFiles);
    if (error?.code === "EEXIST") {
      throw new Error("Local sidecar credentials are already owned by another deployment");
    }
    throw new Error("Local sidecar credentials could not be created");
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    for (const file of ownedFiles) {
      try { unlinkSync(file); }
      catch (error) {
        if (error?.code !== "ENOENT") throw new Error("Local sidecar credential cleanup failed");
      }
    }
  };
}

function validateCredentials(credentials) {
  if (!Array.isArray(credentials) || credentials.length !== 3) {
    throw new Error("Exactly three local sidecar credentials are required");
  }
  const files = new Set();
  for (const credential of credentials) {
    if (!credential || typeof credential !== "object"
      || typeof credential.file !== "string"
      || !isAbsolute(credential.file)
      || resolve(credential.file) !== credential.file
      || credential.file.length > 4_096
      || credential.file.includes("\0")
      || files.has(credential.file)
      || typeof credential.key !== "string"
      || !KEY_PATTERN.test(credential.key)) {
      throw new Error("Local sidecar credential is invalid");
    }
    const bytes = Buffer.from(credential.key, "base64url");
    if (bytes.byteLength < 32 || bytes.byteLength > 64 || bytes.toString("base64url") !== credential.key) {
      throw new Error("Local sidecar credential is invalid");
    }
    files.add(credential.file);
  }
}

async function removeOwnedFiles(files) {
  await Promise.all(files.map(async (file) => {
    try { await unlink(file); }
    catch (error) {
      if (error?.code !== "ENOENT") throw new Error("Local sidecar credential cleanup failed");
    }
  }));
}

async function claimOwner(ownerFile, owner, isProcessAlive) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await writeOwner(ownerFile, owner);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw new Error("Local deployment ownership could not be created");
    }
    const current = await readOwner(ownerFile);
    if (!current) continue;
    if (isProcessAlive(current.pid)) throw new Error("Local sidecar credentials are already owned by another deployment");
    const staleFile = `${ownerFile}.stale-${owner.deploymentId}-${attempt}`;
    try {
      await rename(ownerFile, staleFile);
      await unlink(staleFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error("Stale local deployment ownership could not be fenced");
    }
  }
  throw new Error("Local deployment ownership changed concurrently");
}

async function writeOwner(ownerFile, owner) {
  let handle;
  try {
    handle = await open(ownerFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.chmod(0o600);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
      await unlink(ownerFile).catch(() => undefined);
    }
    throw error;
  }
  await handle.close();
}

async function readOwner(ownerFile) {
  let handle;
  let metadata;
  let raw;
  try {
    handle = await open(ownerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 1_024
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) throw new Error();
    raw = await handle.readFile("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Local deployment ownership record is invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Local deployment ownership record is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...OWNER_FIELDS].sort().join("\0")
    || value.schema !== OWNER_SCHEMA || typeof value.deploymentId !== "string"
    || !/^[A-Za-z0-9_-]{32}$/.test(value.deploymentId)
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error("Local deployment ownership record is invalid");
  }
  return value;
}

async function removeStaleCredentials(credentials, nowMs, staleAfterMs) {
  const stale = [];
  for (const credential of credentials) {
    let metadata;
    try { metadata = await lstat(credential.file); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error("Local sidecar credential recovery failed");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 44 || metadata.size > 87
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)
      || !Number.isFinite(metadata.mtimeMs) || nowMs - metadata.mtimeMs < staleAfterMs) {
      throw new Error("Local sidecar credentials are already owned by another deployment");
    }
    let raw;
    try { raw = await readFile(credential.file, "utf8"); }
    catch { throw new Error("Local sidecar credential recovery failed"); }
    if (raw !== `${raw.trim()}\n` || !KEY_PATTERN.test(raw.trim())) {
      throw new Error("Stale local sidecar credential is invalid");
    }
    stale.push(credential.file);
  }
  await Promise.all(stale.map(async (file) => {
    try { await unlink(file); }
    catch (error) {
      if (error?.code !== "ENOENT") throw new Error("Local sidecar credential recovery failed");
    }
  }));
}

function removeOwnerIfOwned(ownerFile, deploymentId) {
  let descriptor;
  let value;
  try {
    descriptor = openSync(ownerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 1_024
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
      throw new Error("Local deployment ownership cleanup failed");
    }
    value = JSON.parse(readFileSync(descriptor, "utf8"));
  }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("Local deployment ownership cleanup failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (value?.schema !== OWNER_SCHEMA || value?.deploymentId !== deploymentId) return;
  try { unlinkSync(ownerFile); }
  catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Local deployment ownership cleanup failed");
  }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function validateSessionOptions(options, credentials) {
  if (typeof options.ownerFile !== "string" || !isAbsolute(options.ownerFile)
    || resolve(options.ownerFile) !== options.ownerFile || options.ownerFile.length > 4_096
    || options.ownerFile.includes("\0") || credentials.some((credential) => credential.file === options.ownerFile)
    || !Number.isSafeInteger(options.processId) || options.processId < 1
    || typeof options.now !== "function" || typeof options.isProcessAlive !== "function"
    || !Number.isSafeInteger(options.staleAfterMs) || options.staleAfterMs < 1_000 || options.staleAfterMs > 300_000) {
    throw new Error("Local deployment ownership configuration is invalid");
  }
}
