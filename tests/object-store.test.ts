import assert from "node:assert/strict";
import test from "node:test";
import { isValidOutputAuthorizationInput, outputUploadRequiredHeaders } from "@/services/core/src/object-store";

const digest = `sha256:${"a".repeat(64)}`;

test("E2E report artifact kinds are accepted by the output authorization contract", () => {
  assert.equal(isValidOutputAuthorizationInput({
    kind: "E2E_REPORT",
    sha256: digest,
    sizeBytes: 1_024,
  }, 1_048_576), true);
});

test("output authorization rejects malformed artifact metadata", () => {
  assert.equal(isValidOutputAuthorizationInput({ kind: "e2e-report", sha256: digest, sizeBytes: 1 }, 1_048_576), false);
  assert.equal(isValidOutputAuthorizationInput({ kind: "E2E_REPORT", sha256: "sha256:bad", sizeBytes: 1 }, 1_048_576), false);
  assert.equal(isValidOutputAuthorizationInput({ kind: "E2E_REPORT", sha256: digest, sizeBytes: 1_048_577 }, 1_048_576), false);
});

test("pre-signed output uploads do not repeat hoisted S3 metadata as unsigned headers", () => {
  assert.deepEqual(outputUploadRequiredHeaders(1_024), { "content-length": "1024" });
});
