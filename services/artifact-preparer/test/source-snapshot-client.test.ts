import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSourceBundle } from "../../godot-testkit/src/source-bundle-builder";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type {
  TestKitArtifactBrokerHttp,
  TestKitArtifactTransferHttp,
} from "../../runner-control/src/testkit-artifact-client";
import { MtlsAuthoritativeSourceSnapshotClient } from "../src/source-snapshot-client";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const commitSha = "a".repeat(40);
const sourceDigest = "b".repeat(64);
const now = new Date("2030-01-01T00:00:00.000Z");
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("SCM snapshot client downloads and safely extracts only the bound commit/source artifact", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-source-snapshot-client-")));
  try {
    const archive = await sourceArchive(root);
    const fixture = harness(archive);
    const destinationPath = join(root, "materialized");
    assert.deepEqual(await fixture.client.materialize(input(destinationPath)), { sourceDigest });
    assert.equal((await stat(join(destinationPath, "project.godot"))).isFile(), true);
    assert.equal((await readFile(join(destinationPath, "scripts", "main.gd"), "utf8")).includes("extends Node"), true);
    assert.deepEqual(fixture.calls.map((call) => call.path), ["/v1/source-snapshot-grants"]);
    assert.equal(fixture.calls[0]?.body.sourceDigest, sourceDigest);
    assert.equal(fixture.downloads, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SCM snapshot client rejects binding drift, alternate authority and unsafe archives", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-source-snapshot-client-")));
  try {
    const archive = await sourceArchive(root);
    await assert.rejects(harness(archive, { driftGrant: true }).client.materialize(input(join(root, "drift"))), /Broker response is invalid/);
    await assert.rejects(harness(archive, { transferOrigin: "https://evil.invalid" }).client.materialize(input(join(root, "origin"))), /Broker response is invalid/);
    const unsafe = Buffer.alloc(1_024, 0x78);
    const destination = join(root, "unsafe");
    await assert.rejects(harness(unsafe).client.materialize(input(destination)), /Godot TestKit|frame descriptor/);
    await assert.rejects(stat(destination), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SCM snapshot client refuses request and transfer digest drift", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-source-snapshot-client-")));
  try {
    const archive = await sourceArchive(root);
    await assert.rejects(harness(archive, { lieAboutTransfer: true }).client.materialize(input(join(root, "transfer"))), /Broker response is invalid/);
    await assert.rejects(harness(archive).client.materialize({
      ...input(join(root, "request")),
      expectedSourceDigest: "not-a-digest",
    }), /configuration is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SCM snapshot client readiness requires the exact source Broker identity", async () => {
  let method: string | undefined;
  const client = new MtlsAuthoritativeSourceSnapshotClient({ endpoint: "https://scm-snapshot.internal",
    tls: { key: Buffer.alloc(32), certificate: Buffer.alloc(32), ca: Buffer.alloc(32) }, transferCa: Buffer.alloc(32),
    allowedTransferOrigins: ["https://s3.internal"], brokerHttp: async (request) => { method = request.method;
      return { statusCode: 200, payload: { status: "ok", service: "deviludo-source-snapshot" } }; },
    transferHttp: { async upload() { throw new Error("unused"); }, async download() { throw new Error("unused"); } } });
  await client.probe(); assert.equal(method, "GET");
});

function input(destinationPath: string) {
  return {
    tenantId,
    projectId,
    runId,
    mode: "CANDIDATE" as const,
    commitSha,
    expectedSourceDigest: sourceDigest,
    destinationPath,
  };
}

async function sourceArchive(root: string): Promise<Buffer> {
  const source = join(root, "source");
  await mkdir(join(source, "scripts"), { recursive: true });
  await Promise.all([
    writeFile(join(source, "project.godot"), 'config_version=5\n[application]\nconfig/name="Snapshot"\n'),
    writeFile(join(source, "scripts", "main.gd"), "extends Node\nfunc _ready():\n\tpass\n"),
  ]);
  const archivePath = join(root, "source.tar.zst");
  await createSourceBundle(source, archivePath);
  return readFile(archivePath);
}

function harness(archive: Buffer, options: {
  readonly driftGrant?: boolean;
  readonly transferOrigin?: string;
  readonly lieAboutTransfer?: boolean;
} = {}) {
  const artifactDigest = digest(archive);
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let downloads = 0;
  const brokerHttp: TestKitArtifactBrokerHttp = async (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    calls.push({ path: request.url.pathname, body });
    const objectKey = `tenants/${tenantId}/projects/${projectId}/scm-snapshots/${commitSha}/${sourceDigest}/${artifactDigest}.tar.zst`;
    const core = {
      tenantId,
      projectId,
      runId,
      mode: "CANDIDATE",
      commitSha,
      sourceDigest,
      artifactDigest,
      sizeBytes: archive.byteLength,
      objectKey,
      contentType: "application/zstd",
    };
    return { statusCode: 200, payload: {
      schemaVersion: "deviludo.source-snapshot-grant.v1",
      ...core,
      bindingDigest: options.driftGrant ? "f".repeat(64) : sha256Canonical(core),
      method: "GET",
      url: `${options.transferOrigin ?? "https://s3.internal"}/bucket/${objectKey}?signature=opaque`,
      requiredHeaders: {},
      expiresAt: "2030-01-01T00:05:00.000Z",
    } };
  };
  const transferHttp: TestKitArtifactTransferHttp = {
    async upload() { throw new Error("not supported"); },
    async download(request) {
      downloads += 1;
      await writeFile(request.destinationPath, archive, { flag: "wx" });
      return {
        statusCode: 200,
        sizeBytes: archive.byteLength,
        artifactDigest: options.lieAboutTransfer ? "e".repeat(64) : artifactDigest,
      };
    },
  };
  const client = new MtlsAuthoritativeSourceSnapshotClient({
    endpoint: "https://scm-snapshot.internal",
    tls: { key: Buffer.alloc(32), certificate: Buffer.alloc(32), ca: Buffer.alloc(32) },
    transferCa: Buffer.alloc(32),
    allowedTransferOrigins: ["https://s3.internal"],
    brokerHttp,
    transferHttp,
    now: () => now,
  });
  return { client, calls, get downloads() { return downloads; } };
}
