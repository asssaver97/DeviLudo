import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installLocalSidecarCredentials, installLocalSidecarSession } from "../scripts/local/sidecar-credentials.mjs";

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

test("a launcher atomically recovers old credentials only after proving the previous owner is dead", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-sidecar-recovery-"));
  const ownerFile = join(directory, "local-deployment.json");
  const nowMs = Date.parse("2026-07-23T12:00:00.000Z");
  const credentials = [1, 2, 3].map((byte) => ({
    file: join(directory, `sidecar-${byte}.hmac`),
    key: key(byte + 10),
  }));
  try {
    for (const [index, credential] of credentials.entries()) {
      await writeFile(credential.file, `${key(index + 1)}\n`, { mode: 0o600 });
      const staleTime = new Date(nowMs - 60_000);
      await utimes(credential.file, staleTime, staleTime);
    }
    await writeFile(ownerFile, `${JSON.stringify({
      schema: "deviludo.local-sidecar-session.v1",
      deploymentId: "a".repeat(32),
      pid: 777,
      createdAt: "2026-07-23T11:59:00.000Z",
    })}\n`, { mode: 0o600 });

    const session = await installLocalSidecarSession({
      credentials,
      ownerFile,
      processId: 888,
      now: () => nowMs,
      isProcessAlive: () => false,
      staleAfterMs: 1_000,
    });
    for (const credential of credentials) {
      assert.equal((await readFile(credential.file, "utf8")).trim(), credential.key);
    }
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    assert.equal(owner.schema, "deviludo.local-sidecar-session.v1");
    assert.equal(owner.pid, 888);
    assert.equal(JSON.stringify(owner).includes(credentials[0].key), false);
    session.cleanup();
    await assert.rejects(readFile(ownerFile), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an active or recently ambiguous deployment is never reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-sidecar-active-owner-"));
  const ownerFile = join(directory, "local-deployment.json");
  const activeKey = key(31);
  const credentials = [1, 2, 3].map((byte) => ({
    file: join(directory, `sidecar-${byte}.hmac`),
    key: key(byte),
  }));
  try {
    await writeFile(credentials[0].file, `${activeKey}\n`, { mode: 0o600 });
    await writeFile(ownerFile, `${JSON.stringify({
      schema: "deviludo.local-sidecar-session.v1",
      deploymentId: "b".repeat(32),
      pid: 999,
      createdAt: "2026-07-23T12:00:00.000Z",
    })}\n`, { mode: 0o600 });
    await assert.rejects(installLocalSidecarSession({
      credentials,
      ownerFile,
      processId: 1_000,
      now: () => Date.parse("2026-07-23T12:01:00.000Z"),
      isProcessAlive: () => true,
      staleAfterMs: 1_000,
    }), /already owned/);
    assert.equal((await readFile(credentials[0].file, "utf8")).trim(), activeKey);

    await rm(ownerFile);
    await assert.rejects(installLocalSidecarSession({
      credentials,
      ownerFile,
      processId: 1_000,
      now: () => Date.now(),
      isProcessAlive: () => false,
      staleAfterMs: 30_000,
    }), /already owned/);
    assert.equal((await readFile(credentials[0].file, "utf8")).trim(), activeKey);
    await assert.rejects(readFile(ownerFile), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed deployment owner fails closed without touching credential files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-sidecar-invalid-owner-"));
  const ownerFile = join(directory, "local-deployment.json");
  const activeFile = join(directory, "sidecar-1.hmac");
  const activeKey = key(42);
  try {
    await writeFile(activeFile, `${activeKey}\n`, { mode: 0o600 });
    await writeFile(ownerFile, "{}\n", { mode: 0o600 });
    await assert.rejects(installLocalSidecarSession({
      credentials: [1, 2, 3].map((byte) => ({ file: join(directory, `sidecar-${byte}.hmac`), key: key(byte) })),
      ownerFile,
      isProcessAlive: () => false,
    }), /ownership record is invalid/);
    assert.equal((await readFile(activeFile, "utf8")).trim(), activeKey);
    assert.equal(await readFile(ownerFile, "utf8"), "{}\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an owner record with widened filesystem permissions fails closed", async (context) => {
  if (process.platform === "win32") context.skip("POSIX mode bits are not enforced on Windows");
  const directory = await mkdtemp(join(tmpdir(), "deviludo-sidecar-owner-mode-"));
  const ownerFile = join(directory, "local-deployment.json");
  const activeFile = join(directory, "sidecar-1.hmac");
  const activeKey = key(51);
  try {
    await writeFile(activeFile, `${activeKey}\n`, { mode: 0o600 });
    await writeFile(ownerFile, `${JSON.stringify({
      schema: "deviludo.local-sidecar-session.v1",
      deploymentId: "c".repeat(32),
      pid: 9_999,
      createdAt: "2026-07-23T12:00:00.000Z",
    })}\n`, { mode: 0o644 });
    await assert.rejects(installLocalSidecarSession({
      credentials: [1, 2, 3].map((byte) => ({ file: join(directory, `sidecar-${byte}.hmac`), key: key(byte) })),
      ownerFile,
      isProcessAlive: () => false,
    }), /ownership record is invalid/);
    assert.equal((await readFile(activeFile, "utf8")).trim(), activeKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
