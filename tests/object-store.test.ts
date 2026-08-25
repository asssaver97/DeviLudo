import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidOutputAuthorizationInput,
  MULTIPART_OUTPUT_PART_BYTES,
  MULTIPART_OUTPUT_THRESHOLD_BYTES,
  newProjectAssetObjectKey,
  outputUploadRequiredHeaders,
} from "@/services/core/src/object-store";

const digest = `sha256:${"a".repeat(64)}`;

test("E2E report artifact kinds are accepted by the output authorization contract", () => {
  assert.equal(isValidOutputAuthorizationInput({
    kind: "E2E_REPORT",
    sha256: digest,
    sizeBytes: 1_024,
  }, 1_048_576), true);
});

test("large outputs use S3-compatible bounded multipart sizing", () => {
  assert.equal(MULTIPART_OUTPUT_THRESHOLD_BYTES, 64 * 1024 * 1024);
  assert.equal(MULTIPART_OUTPUT_PART_BYTES, 16 * 1024 * 1024);
  assert.ok(MULTIPART_OUTPUT_PART_BYTES >= 5 * 1024 * 1024);
  assert.ok(Math.ceil(2_147_483_648 / MULTIPART_OUTPUT_PART_BYTES) < 10_000);
});

test("output authorization rejects malformed artifact metadata", () => {
  assert.equal(isValidOutputAuthorizationInput({ kind: "e2e-report", sha256: digest, sizeBytes: 1 }, 1_048_576), false);
  assert.equal(isValidOutputAuthorizationInput({ kind: "E2E_REPORT", sha256: "sha256:bad", sizeBytes: 1 }, 1_048_576), false);
  assert.equal(isValidOutputAuthorizationInput({ kind: "E2E_REPORT", sha256: digest, sizeBytes: 1_048_577 }, 1_048_576), false);
});

test("pre-signed output uploads do not repeat hoisted S3 metadata as unsigned headers", () => {
  assert.deepEqual(outputUploadRequiredHeaders(1_024), {
    "content-length": "1024",
    "content-type": "application/octet-stream",
  });
});

test("project assets use unique object keys so retired objects cannot alias replacements", () => {
  const input = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    assetKey: "ui/start-panel",
    extension: "png",
    sha256: digest,
  } as const;
  const first = newProjectAssetObjectKey(input);
  const second = newProjectAssetObjectKey(input);

  assert.notEqual(first, second);
  assert.match(first, /\/assets\/ui\/start-panel-a{16}-[0-9a-f-]{36}\.png$/);
});
