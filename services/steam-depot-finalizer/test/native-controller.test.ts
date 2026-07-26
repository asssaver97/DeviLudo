import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createEvidencePackage, type EvidencePackageEntry } from "../../godot-testkit/src/evidence-package";
import { steamCanonicalDigest } from "../../steam-publisher/src/artifacts";
import type { SteamDepotSigningScheme } from "../../steam-publisher/src/depot-finalization";
import type { SteamTargetPlatform } from "../../steam-publisher/src/contracts";
import { parseSteamDepotFinalizationRequest } from "../src/contract";
import {
  extractProductionExport,
  NativeSteamDepotController,
  type SteamDepotArtifactStore,
  type SteamDepotPlatformSigner,
} from "../src/native-controller";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";

class MemoryArtifactStore implements SteamDepotArtifactStore {
  readonly objects = new Map<string, Readonly<{ digest: string; contentType: string; body: Buffer }>>();
  probeCalls = 0;
  async probe() { this.probeCalls += 1; }
  async download(input: { objectKey: string; artifactDigest: string; maximumBytes: number }) {
    const value = this.objects.get(input.objectKey);
    if (!value || value.digest !== input.artifactDigest || value.body.byteLength > input.maximumBytes) throw new Error("missing");
    return Buffer.from(value.body);
  }
  async putImmutable(input: { objectKey: string; artifactDigest: string; contentType: "application/json" | "application/octet-stream"; body: Buffer }) {
    assert.equal(sha(input.body), input.artifactDigest);
    const current = this.objects.get(input.objectKey);
    if (current) {
      assert.equal(current.digest, input.artifactDigest);
      assert.deepEqual(current.body, input.body);
      return;
    }
    this.objects.set(input.objectKey, Object.freeze({
      digest: input.artifactDigest, contentType: input.contentType, body: Buffer.from(input.body),
    }));
  }
}

test("native controller reconstructs, signs and content-addresses every Godot desktop export", async () => {
  for (const platform of ["windows", "linux", "macos"] as const) {
    const root = await mkdtemp(join(tmpdir(), `deviludo-native-controller-${platform}-`));
    const workRoot = join(root, "work"); await mkdir(workRoot);
    const source = await productionExport(root, platform);
    const request = finalizationRequest(platform, sha(source));
    const store = new MemoryArtifactStore();
    store.objects.set(request.sourceObjectKey, Object.freeze({
      digest: request.sourceArtifactDigest, contentType: "application/octet-stream", body: source,
    }));
    let signingTarget = ""; let signCalls = 0;
    const signer: SteamDepotPlatformSigner = {
      platform,
      signingScheme: signingScheme(platform),
      async probe() { return undefined; },
      async sign(input) {
        signCalls += 1; signingTarget = input.signingTarget;
        const target = platform === "macos" ? join(input.signingTarget, "Contents", "MacOS", "DeviLudo") : input.signingTarget;
        await appendFile(target, `\nsigned-${platform}`);
        if (platform === "macos") {
          const signatureDirectory = join(input.signingTarget, "Contents", "_CodeSignature");
          await mkdir(signatureDirectory);
          await writeFile(join(signatureDirectory, "CodeResources"), "detached-signature", { mode: 0o600 });
        }
        const shared = {
          requestDigest: request.requestDigest, platform, signingScheme: signingScheme(platform), status: "VERIFIED",
        };
        return {
          signingIdentityDigest: sha(Buffer.from(`identity-${platform}`)),
          signingEvidence: Buffer.from(JSON.stringify({
            schemaVersion: "deviludo.native-steam-depot-signing-evidence.v1", ...shared,
          })),
          notarizationEvidence: platform === "macos" ? Buffer.from(JSON.stringify({
            schemaVersion: "deviludo.native-steam-depot-notarization-evidence.v1", ...shared,
          })) : null,
        };
      },
    };
    const controller = new NativeSteamDepotController({ artifacts: store, signer, workRoot });
    await controller.probe();
    const receipt = await controller.finalize(request);
    assert.equal(signCalls, 1);
    assert.equal(store.probeCalls, 1);
    assert.equal(receipt.signingScheme, signingScheme(platform));
    assert.equal(receipt.sourceArtifactDigest, request.sourceArtifactDigest);
    assert.notEqual(receipt.artifactDigest, request.sourceArtifactDigest);
    assert.equal(store.objects.get(receipt.artifactObjectKey)?.contentType, "application/octet-stream");
    assert.equal(store.objects.get(receipt.signingEvidenceObjectKey)?.contentType, "application/json");
    assert.equal(platform === "macos", receipt.notarizationEvidenceObjectKey !== null);
    assert.match(signingTarget, platform === "windows" ? /DeviLudo\.exe$/
      : platform === "linux" ? /DeviLudo\.x86_64$/ : /DeviLudo\.app$/);
    const finalizedRoot = join(root, "finalized"); await mkdir(finalizedRoot);
    const finalized = store.objects.get(receipt.artifactObjectKey)?.body;
    assert.ok(finalized);
    await extractProductionExport(finalized, finalizedRoot, platform);
    const target = platform === "windows" ? join(finalizedRoot, "DeviLudo.exe")
      : platform === "linux" ? join(finalizedRoot, "DeviLudo.x86_64")
        : join(finalizedRoot, "DeviLudo.app", "Contents", "MacOS", "DeviLudo");
    assert.match(await readFile(target, "utf8"), new RegExp(`signed-${platform}$`));
    if (platform === "macos") {
      assert.equal(await readFile(join(finalizedRoot, "DeviLudo.app", "Contents", "_CodeSignature", "CodeResources"), "utf8"), "detached-signature");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("native controller rejects source digest drift before a signing tool is called", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-controller-drift-"));
  const workRoot = join(root, "work"); await mkdir(workRoot);
  const source = await productionExport(root, "linux");
  const request = finalizationRequest("linux", "a".repeat(64));
  const store = new MemoryArtifactStore();
  store.objects.set(request.sourceObjectKey, Object.freeze({
    digest: request.sourceArtifactDigest, contentType: "application/octet-stream", body: source,
  }));
  let calls = 0;
  const controller = new NativeSteamDepotController({ artifacts: store, workRoot, signer: {
    platform: "linux", signingScheme: "LINUX_SIGSTORE", async probe() {},
    async sign() { calls += 1; throw new Error("must not execute"); },
  } });
  await assert.rejects(controller.finalize(request), /source artifact is invalid/);
  assert.equal(calls, 0);
  await rm(root, { recursive: true, force: true });
});

test("native controller rejects a manifest traversal before materializing an export", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-controller-traversal-"));
  const packagePath = join(root, "bad.tar");
  const body = Buffer.from("malicious");
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: "deviludo.production-export-evidence.v1",
    jobDigest: "9".repeat(64),
    platform: "linux",
    files: [{ index: 0, path: "../escape", sha256: sha(body), sizeBytes: body.byteLength }],
  }));
  await createEvidencePackage(packagePath, [
    { name: "files/000000.bin", body }, { name: "manifest.json", body: manifest },
  ]);
  const source = await readFile(packagePath);
  const request = finalizationRequest("linux", sha(source));
  const workRoot = join(root, "work"); await mkdir(workRoot);
  const store = new MemoryArtifactStore();
  store.objects.set(request.sourceObjectKey, Object.freeze({
    digest: request.sourceArtifactDigest, contentType: "application/octet-stream", body: source,
  }));
  let calls = 0;
  const controller = new NativeSteamDepotController({ artifacts: store, workRoot, signer: {
    platform: "linux", signingScheme: "LINUX_SIGSTORE", async probe() {},
    async sign() { calls += 1; throw new Error("must not execute"); },
  } });
  await assert.rejects(controller.finalize(request), /manifest file is invalid/);
  assert.equal(calls, 0);
  await assert.rejects(readFile(join(root, "escape")), { code: "ENOENT" });
  await rm(root, { recursive: true, force: true });
});

async function productionExport(root: string, platform: SteamTargetPlatform): Promise<Buffer> {
  const packagePath = join(root, `${platform}.tar`);
  const files = platform === "windows"
    ? [{ path: "DeviLudo.exe", body: Buffer.from("windows-game") }]
    : platform === "linux"
      ? [{ path: "DeviLudo.x86_64", body: Buffer.from("linux-game") }]
      : [
        { path: "DeviLudo.app/Contents/MacOS/DeviLudo", body: Buffer.from("macos-game") },
        { path: "DeviLudo.app/Contents/Resources/game.pck", body: Buffer.from("macos-data") },
      ];
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: "deviludo.production-export-evidence.v1",
    jobDigest: "9".repeat(64),
    platform,
    files: files.map((file, index) => ({ index, path: file.path, sha256: sha(file.body), sizeBytes: file.body.byteLength })),
  }));
  const entries: EvidencePackageEntry[] = [{ name: "manifest.json", body: manifest }];
  files.forEach((file, index) => entries.push({ name: `files/${String(index).padStart(6, "0")}.bin`, body: file.body }));
  entries.sort((left, right) => left.name.localeCompare(right.name));
  await createEvidencePackage(packagePath, entries);
  return readFile(packagePath);
}

function finalizationRequest(platform: SteamTargetPlatform, sourceArtifactDigest: string) {
  const core = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalization.v1" as const,
    operationKey: `steam-depot-finalize:${releaseId}:${platform}`,
    tenantId, projectId, releaseId,
    mainCommitSha: "1".repeat(40),
    evidenceBundleDigest: "2".repeat(64),
    platform,
    sourceObjectKey: `tenants/${tenantId}/projects/${projectId}/runner-artifacts/${attemptId}/${platform}/production-export/${sourceArtifactDigest}`,
    sourceArtifactDigest,
  });
  return parseSteamDepotFinalizationRequest({ ...core, requestDigest: steamCanonicalDigest(core) });
}
function signingScheme(platform: SteamTargetPlatform): SteamDepotSigningScheme {
  return platform === "windows" ? "WINDOWS_AUTHENTICODE" : platform === "linux" ? "LINUX_SIGSTORE" : "MACOS_DEVELOPER_ID";
}
function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
