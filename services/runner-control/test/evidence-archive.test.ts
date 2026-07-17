import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceBundle } from "../../../lib/domain/e2e";
import {
  MtlsRunnerEvidenceArchive,
  type RunnerEvidenceArchiveHttpRequest,
} from "../src/evidence-archive";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const sha = (value: string) => value.repeat(64);

function bundle(status: "PASSED" | "FAILED" = "PASSED"): EvidenceBundle {
  return {
    id: attemptId,
    attemptId,
    specRevisionId: "44444444-4444-4444-8444-444444444444",
    specDigest: sha("1"),
    testPlanDigest: sha("2"),
    commitSha: "a".repeat(40),
    sourceDigest: sha("3"),
    targetMatrix: ["linux"],
    godotTestKitDigest: sha("4"),
    buildManifestDigest: sha("5"),
    sbomDigest: sha("6"),
    vulnerabilityScanDigest: sha("7"),
    assetLicenseLedgerDigest: sha("8"),
    platformEvidence: [{
      platform: "linux",
      runnerId: "runner-linux-1",
      runnerCapabilityDigest: sha("9"),
      exportDigest: sha("a"),
      logsDigest: sha("b"),
      junitDigest: sha("c"),
      inputTimelineDigest: sha("d"),
      screenshotManifestDigest: sha("e"),
      videoManifestDigest: sha("f"),
      status,
    }],
    bundleDigest: sha("0"),
    status,
    valid: true,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

const tls = {
  key: Buffer.alloc(64, 1),
  certificate: Buffer.alloc(64, 2),
  ca: Buffer.alloc(64, 3),
};

test("mTLS evidence archive submits one digest-idempotent immutable bundle", async () => {
  let submitted: { url: URL; input: RunnerEvidenceArchiveHttpRequest } | undefined;
  const archive = new MtlsRunnerEvidenceArchive({
    endpoint: "https://evidence.internal/v1/runner-evidence",
    tls,
    http: async (url, input) => {
      submitted = { url, input };
      return {
        statusCode: 201,
        payload: {
          schemaVersion: "deviludo.runner-evidence-archive-receipt.v1",
          tenantId,
          projectId,
          attemptId,
          bundleDigest: sha("0"),
          objectKey: `tenants/${tenantId}/projects/${projectId}/evidence/${sha("0")}.json`,
          repairPromptId: null,
        },
      };
    },
  });

  const receipt = await archive.persistBundle({ tenantId, projectId, bundle: bundle() });
  assert.equal(receipt.objectKey.endsWith(`${sha("0")}.json`), true);
  assert.equal(submitted?.url.href, "https://evidence.internal/v1/runner-evidence");
  assert.equal(submitted?.input.method, "POST");
  assert.equal(submitted?.input.headers["idempotency-key"], sha("0"));
  assert.equal(submitted?.input.headers["x-deviludo-bundle-digest"], sha("0"));
  const request = JSON.parse(submitted?.input.body ?? "null") as Record<string, unknown>;
  assert.deepEqual(Object.keys(request).sort(), [
    "attemptId", "bundle", "bundleDigest", "projectId", "schemaVersion", "tenantId",
  ]);
  assert.equal((request.bundle as EvidenceBundle).bundleDigest, sha("0"));
});

test("evidence archive verifies health and every immutable receipt binding", async () => {
  const archive = new MtlsRunnerEvidenceArchive({
    endpoint: "https://evidence.internal/v1/runner-evidence",
    tls,
    http: async (url) => url.pathname === "/healthz"
      ? { statusCode: 200, payload: { status: "ok", service: "deviludo-evidence-archive" } }
      : {
          statusCode: 200,
          payload: {
            schemaVersion: "deviludo.runner-evidence-archive-receipt.v1",
            tenantId,
            projectId,
            attemptId,
            bundleDigest: sha("f"),
            objectKey: "wrong",
            repairPromptId: null,
          },
        },
  });
  await archive.probe();
  await assert.rejects(
    archive.persistBundle({ tenantId, projectId, bundle: bundle() }),
    /invalid receipt/,
  );
});

test("evidence archive rejects insecure or ambiguous endpoints and malformed TLS", () => {
  for (const endpoint of [
    "http://evidence.internal/v1/runner-evidence",
    "https://user:secret@evidence.internal/v1/runner-evidence",
    "https://evidence.internal/v1/runner-evidence?token=secret",
    "https://evidence.internal/other",
  ]) {
    assert.throws(() => new MtlsRunnerEvidenceArchive({ endpoint, tls }), /URL is invalid/);
  }
  assert.throws(() => new MtlsRunnerEvidenceArchive({
    endpoint: "https://evidence.internal/v1/runner-evidence",
    tls: { ...tls, key: Buffer.alloc(1) },
  }), /TLS material is invalid/);
});
