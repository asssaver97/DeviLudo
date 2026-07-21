import { constants, unlinkSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const KEY_PATTERN = /^[A-Za-z0-9_-]{43,86}$/;

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
