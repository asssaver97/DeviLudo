import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GET as downloadBuild } from "../app/api/projects/[projectId]/local-validation/artifact/[file]/route.ts";
import { saveLocalValidation, startLocalDelivery } from "../lib/local-delivery/store.ts";
import { LocalRuntimeRequestVerifier } from "../services/local-runtime/src/request-auth.ts";
import { ensureLocalProject } from "./helpers/local-project.mjs";

const sidecarKey = new Uint8Array(Buffer.alloc(32, 73));
process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY = Buffer.from(sidecarKey).toString("base64url");

function request(projectId, file = "DeviLudoLocal.zip") {
  return new Request(`http://127.0.0.1:3000/api/projects/${projectId}/local-validation/artifact/${file}`);
}

test("local build download streams only the manifest-bound macOS artifact", async () => {
  const projectId = `build-download-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(projectId, "SPEC-BUILD-001", "RUN-BUILD-001", `start:${projectId}`, undefined, ["macos"]);
  const bytes = Buffer.from("signed local macOS Godot build bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await saveLocalValidation(projectId, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-BUILD123456",
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "a".repeat(40), sourceDigest: "b".repeat(64), bundleDigest: "c".repeat(64),
    godotVersion: "4.6.2.stable",
    targetMatrix: started.snapshot.targetMatrix,
    platform: "macos",
    fixtureOnly: true,
    buildArtifact: {
      fileName: "DeviLudoLocal.zip", platform: "macos", contentType: "application/zip", sha256, sizeBytes: bytes.byteLength,
    },
    checks: [
      { name: "import", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "boot", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "core-loop", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "macos-export", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "exported app booted" },
    ],
    createdAt: "2026-07-23T00:00:00.000Z",
  }, `validation:${projectId}`);

  const verifier = new LocalRuntimeRequestVerifier(sidecarKey);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const path = new URL(String(input)).pathname;
    assert.equal(path, `/v1/runs/${projectId}/RUN-BUILD-001/artifacts/DeviLudoLocal.zip`);
    verifier.verify({ method: "GET", path, body: "", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(bytes, { headers: {
      "content-type": "application/zip",
      "content-length": String(bytes.byteLength),
      "x-deviludo-artifact-sha256": sha256,
    } });
  };
  try {
    const response = await downloadBuild(request(projectId), {
      params: Promise.resolve({ projectId, file: "DeviLudoLocal.zip" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="DeviLudoLocal.zip"');
    assert.equal(response.headers.get("x-deviludo-artifact-sha256"), sha256);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(calls, 1);

    const unknown = await downloadBuild(request(projectId, "other.zip"), {
      params: Promise.resolve({ projectId, file: "other.zip" }),
    });
    assert.equal(unknown.status, 404);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local build download rejects sidecar metadata drift before streaming bytes", async () => {
  const projectId = `build-drift-${crypto.randomUUID()}`;
  await ensureLocalProject(projectId);
  const started = await startLocalDelivery(projectId, "SPEC-BUILD-002", "RUN-BUILD-002", `start:${projectId}`, undefined, ["macos"]);
  const bytes = Buffer.from("manifest-bound bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await saveLocalValidation(projectId, {
    schemaVersion: 4,
    evidenceId: "EV-LOCAL-BUILD654321",
    status: "TESTS_PASSED",
    releaseGate: "LOCAL_VALIDATION_PASSED",
    candidateSha: "d".repeat(40), sourceDigest: "e".repeat(64), bundleDigest: "f".repeat(64),
    godotVersion: "4.6.2.stable", targetMatrix: started.snapshot.targetMatrix,
    platform: "macos", fixtureOnly: true,
    buildArtifact: { fileName: "DeviLudoLocal.zip", platform: "macos", contentType: "application/zip", sha256, sizeBytes: bytes.byteLength },
    checks: [
      { name: "import", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "boot", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "core-loop", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "macos-export", status: "PASSED", durationMs: 1, detail: "fixture" },
      { name: "macos-export-boot", status: "PASSED", durationMs: 1, detail: "exported app booted" },
    ],
    createdAt: "2026-07-23T00:00:00.000Z",
  }, `validation:${projectId}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes, { headers: {
    "content-type": "application/zip", "content-length": String(bytes.byteLength),
    "x-deviludo-artifact-sha256": "0".repeat(64),
  } });
  try {
    const response = await downloadBuild(request(projectId), {
      params: Promise.resolve({ projectId, file: "DeviLudoLocal.zip" }),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "BUILD_ARTIFACT_UNAVAILABLE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
