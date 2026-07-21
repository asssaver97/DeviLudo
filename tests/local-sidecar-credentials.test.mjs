import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installLocalSidecarCredentials } from "../scripts/local/sidecar-credentials.mjs";

const key = (byte) => Buffer.alloc(32, byte).toString("base64url");

test("local launcher owns and removes only the sidecar credentials it atomically creates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-sidecar-credentials-"));
  const credentials = [1, 2, 3].map((byte) => ({
    file: join(directory, `sidecar-${byte}.hmac`),
    key: key(byte),
  }));
  try {
    const cleanup = await installLocalSidecarCredentials(credentials);
    for (const credential of credentials) {
      assert.equal((await readFile(credential.file, "utf8")).trim(), credential.key);
      if (process.platform !== "win32") assert.equal((await stat(credential.file)).mode & 0o777, 0o600);
    }
    await cleanup();
    await cleanup();
    for (const credential of credentials) {
      await assert.rejects(readFile(credential.file), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed second launcher never replaces or deletes an active deployment key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-sidecar-ownership-"));
  const activeFile = join(directory, "active.hmac");
  const partialFile = join(directory, "partial.hmac");
  const thirdFile = join(directory, "third.hmac");
  await writeFile(activeFile, `${key(7)}\n`, { mode: 0o600 });
  try {
    await assert.rejects(installLocalSidecarCredentials([
      { file: partialFile, key: key(1) },
      { file: activeFile, key: key(2) },
      { file: thirdFile, key: key(3) },
    ]), /already owned/);
    assert.equal((await readFile(activeFile, "utf8")).trim(), key(7));
    await assert.rejects(readFile(partialFile), { code: "ENOENT" });
    await assert.rejects(readFile(thirdFile), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
