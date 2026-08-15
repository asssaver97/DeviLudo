import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enrollRemoteE2e } from "../scripts/remote-e2e-enroll.mjs";

test("development enrollment exchanges a one-time code for a durable node-bound credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-remote-enrollment-"));
  const enrollmentFile = join(directory, "enrollment-token");
  const runtimeFile = join(directory, "golden-vm.zip");
  const credentials = join(directory, "credentials");
  const enrollmentToken = "E".repeat(48);
  await writeFile(enrollmentFile, enrollmentToken);
  await writeFile(runtimeFile, "deterministic golden VM fixture");
  const requests: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
        nodeId: "10000000-0000-4000-8000-000000000001",
        poolKind: "E2E_WINDOWS",
        operatingSystem: "windows",
      }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const arguments_ = [
      "--platform", "windows",
      "--core-url", "http://127.0.0.1:8080",
      "--enrollment-token-file", enrollmentFile,
      "--runtime-image-file", runtimeFile,
      "--credential-directory", credentials,
    ];
    const first = await enrollRemoteE2e(arguments_);
    assert.equal(first.token, "***");
    const stored = JSON.parse(await readFile(join(credentials, "node.json"), "utf8")) as Record<string, string>;
    assert.notEqual(stored.token, enrollmentToken);
    assert.match(stored.token, /^[A-Za-z0-9_-]{40,200}$/);
    assert.equal(requests[0].token, enrollmentToken);
    assert.equal(
      requests[0].nodeAuthTokenHash,
      `sha256:${createHash("sha256").update(stored.token).digest("hex")}`,
    );

    const second = await enrollRemoteE2e(arguments_);
    assert.equal(second.token, "***");
    assert.equal(requests[1].nodeAuthTokenHash, requests[0].nodeAuthTokenHash);
    assert.equal(
      (JSON.parse(await readFile(join(credentials, "node.json"), "utf8")) as Record<string, string>).token,
      stored.token,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("development enrollment refuses relative credential and runtime paths", async () => {
  await assert.rejects(() => enrollRemoteE2e([
    "--platform", "windows",
    "--core-url", "http://127.0.0.1:8080",
    "--enrollment-token-file", "token.txt",
    "--runtime-image-file", "golden.zip",
    "--credential-directory", "credentials",
  ]), /paths must be absolute/);
});
