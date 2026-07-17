import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EvidenceBundle, PlatformEvidence } from "../../../lib/domain/e2e";
import { sha256Canonical } from "../../runner-control/src/canonical";
import { MtlsRunnerEvidenceArchive } from "../../runner-control/src/evidence-archive";
import { EvidenceArchiveService, parseEvidenceArchiveRequest } from "../src/archive";
import type { ImmutableObjectPut, ImmutableObjectStore } from "../src/contracts";
import { FilesystemImmutableObjectStore } from "../src/filesystem-store";
import { createEvidenceArchiveHandler } from "../src/ingress-http";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const specRevisionId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2030-01-01T00:01:00.000Z");

function sha(character: string): string { return character.repeat(64); }

function platform(platform: "linux" | "macos", status: "PASSED" | "FAILED" = "PASSED"): PlatformEvidence {
  return Object.freeze({
    platform,
    runnerId: `runner-${platform}-1`,
    runnerCapabilityDigest: sha("1"),
    exportDigest: sha("2"),
    logsDigest: sha("3"),
    junitDigest: sha("4"),
    inputTimelineDigest: sha("5"),
    screenshotManifestDigest: sha("6"),
    videoManifestDigest: sha("7"),
    status,
  });
}

function bundle(failed = false): EvidenceBundle {
  const core = {
    id: attemptId,
    attemptId,
    specRevisionId,
    specDigest: sha("8"),
    testPlanDigest: sha("9"),
    commitSha: "a".repeat(40),
    sourceDigest: sha("b"),
    targetMatrix: ["linux", "macos"] as const,
    godotTestKitDigest: sha("c"),
    buildManifestDigest: sha("d"),
    sbomDigest: sha("e"),
    vulnerabilityScanDigest: sha("f"),
    assetLicenseLedgerDigest: sha("0"),
    platformEvidence: [platform("linux", failed ? "FAILED" : "PASSED"), platform("macos")],
    status: failed ? "FAILED" as const : "PASSED" as const,
    valid: true as const,
    createdAt: "2030-01-01T00:00:30.000Z",
  };
  return Object.freeze({ ...core, bundleDigest: sha256Canonical(core) });
}

function request(evidence = bundle()) {
  return Object.freeze({
    schemaVersion: "deviludo.runner-evidence-archive.v1" as const,
    tenantId,
    projectId,
    attemptId,
    bundleDigest: evidence.bundleDigest,
    bundle: evidence,
  });
}

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, ImmutableObjectPut>();

  async putImmutable(input: ImmutableObjectPut): Promise<Readonly<{ created: boolean }>> {
    const current = this.objects.get(input.objectKey);
    if (current) {
      if (current.contentDigest !== input.contentDigest || !current.body.equals(input.body)) throw new Error("conflict");
      return Object.freeze({ created: false });
    }
    this.objects.set(input.objectKey, Object.freeze({ ...input, body: Buffer.from(input.body) }));
    return Object.freeze({ created: true });
  }

  async probe(): Promise<void> {}
}

test("archives one verified passing bundle idempotently at its tenant-scoped content address", async () => {
  const store = new MemoryStore();
  const archive = new EvidenceArchiveService({ store, now: () => now });
  const first = await archive.persist(request());
  const replay = await archive.persist(request());

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(first.receipt.repairPromptId, null);
  assert.equal(first.receipt.objectKey, `tenants/${tenantId}/projects/${projectId}/evidence/${bundle().bundleDigest}.json`);
  assert.equal(store.objects.size, 1);
  const stored = store.objects.get(first.receipt.objectKey)!;
  assert.equal(createHash("sha256").update(stored.body).digest("hex"), stored.contentDigest);
});

test("a failed bundle creates a deterministic immutable repair prompt beside the evidence", async () => {
  const store = new MemoryStore();
  const archive = new EvidenceArchiveService({ store, now: () => now });
  const failed = bundle(true);
  const result = await archive.persist(request(failed));

  assert.equal(result.receipt.repairPromptId, `repair:${failed.bundleDigest}`);
  assert.equal(store.objects.size, 2);
  const prompt = JSON.parse(store.objects.get(
    `tenants/${tenantId}/projects/${projectId}/repairs/${failed.bundleDigest}.json`,
  )!.body.toString("utf8")) as { failedPlatforms: Array<{ platform: string }> };
  assert.deepEqual(prompt.failedPlatforms.map((item) => item.platform), ["linux"]);
});

test("archive validation rejects digest, matrix, status, field and request-binding drift", () => {
  const valid = request();
  assert.throws(() => parseEvidenceArchiveRequest({ ...valid, bundleDigest: sha("0") }, now), /bundle binding/);
  assert.throws(() => parseEvidenceArchiveRequest({ ...valid, future: true }, now), /request fields/);
  assert.throws(() => parseEvidenceArchiveRequest({ ...valid, bundle: { ...valid.bundle, status: "FAILED" } }, now), /bundle status/);
  assert.throws(() => parseEvidenceArchiveRequest({
    ...valid,
    bundle: { ...valid.bundle, targetMatrix: ["macos", "linux"] },
  }, now), /target matrix order/);
});

test("filesystem backend uses no-replace content checks and rejects traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-evidence-archive-"));
  const store = new FilesystemImmutableObjectStore({ root: join(root, "objects") });
  const body = Buffer.from("{\"verified\":true}\n");
  const contentDigest = createHash("sha256").update(body).digest("hex");
  const input = {
    objectKey: "tenants/one/projects/two/evidence/object.json",
    contentType: "application/json" as const,
    contentDigest,
    body,
  };
  assert.equal((await store.putImmutable(input)).created, true);
  assert.equal((await store.putImmutable(input)).created, false);
  assert.deepEqual(await readFile(join(root, "objects", ...input.objectKey.split("/"))), body);
  await assert.rejects(store.putImmutable({
    ...input,
    body: Buffer.from("{\"verified\":false}\n"),
    contentDigest: createHash("sha256").update("{\"verified\":false}\n").digest("hex"),
  }), /conflicts/);
  await assert.rejects(store.putImmutable({ ...input, objectKey: "tenants/../escape.json" }), /invalid/);
});

test("Runner ingress client and archive server share one exact mTLS evidence contract", async () => {
  const store = new MemoryStore();
  const archive = new EvidenceArchiveService({ store, now: () => now });
  const spiffeId = "spiffe://deviludo.internal/runner-control/ingress";
  const handler = createEvidenceArchiveHandler({
    archive,
    allowedSpiffeIds: new Set([spiffeId]),
    extractIdentity: () => ({
      spiffeId,
      certificateFingerprint: sha("a"),
      certificateSerial: "01",
      certificateNotAfter: "2030-01-01T01:00:00.000Z",
    }),
  });
  const client = new MtlsRunnerEvidenceArchive({
    endpoint: "https://evidence.internal/v1/runner-evidence",
    tls: {
      key: Buffer.alloc(32, 1),
      certificate: Buffer.alloc(32, 2),
      ca: Buffer.alloc(32, 3),
    },
    http: async (url, input) => {
      const response = await handler({
        method: input.method,
        path: url.pathname,
        headers: input.headers,
        socket: {},
        rawBody: input.body ?? "",
      });
      return { statusCode: response.status, payload: response.body };
    },
  });
  const evidence = bundle(true);
  const receipt = await client.persistBundle({ tenantId, projectId, bundle: evidence });
  assert.equal(receipt.objectKey, `tenants/${tenantId}/projects/${projectId}/evidence/${evidence.bundleDigest}.json`);
  assert.equal(receipt.repairPromptId, `repair:${evidence.bundleDigest}`);
});
