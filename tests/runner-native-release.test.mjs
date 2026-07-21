import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildRunnerNativeCandidates,
  parseRunnerNativeBuildArguments,
} from "../scripts/production/build-runner-native.mjs";
import { parseRunnerNativeFinalizationArguments } from "../scripts/production/finalize-runner-native-release.mjs";
import {
  canonicalJson,
  runnerNativeTrustPolicyDigest,
  sha256Canonical,
  validateRunnerNativeBuildReceipt,
  validateRunnerNativeTrustPolicy,
  verifyRunnerNativeRelease,
  verifyRunnerNativeReleaseEnvelope,
} from "../scripts/production/runner-native-release.mjs";
import {
  MtlsRunnerNativeReleaseSigner,
  prepareRunnerNativeReleaseClaims,
} from "../scripts/production/runner-native-finalizer.mjs";
import {
  inspectRunnerNativeTrustPolicy,
  parseRunnerNativeTrustInspectionArguments,
} from "../scripts/production/inspect-runner-native-trust-policy.mjs";
import { parseRunnerNativeVerificationArguments } from "../scripts/production/verify-runner-native-release.mjs";

const keyPair = generateKeyPairSync("ed25519");
const keyId = "runner-native-release-2026-01";
const policy = Object.freeze({
  schemaVersion: "deviludo.runner-native-trust-policy.v1",
  policyId: "deviludo-runner-native-production",
  policyRevision: 1,
  keys: Object.freeze([Object.freeze({
    keyId,
    algorithm: "Ed25519",
    publicKeySpkiBase64: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "ACTIVE",
  })]),
});
const policyDigest = runnerNativeTrustPolicyDigest(policy);
const sourceRevision = "a".repeat(40);
const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const architecture = process.arch === "x64" ? "x86_64" : process.arch;

test("native builder accepts only pinned absolute inputs and atomically emits all host candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-builder-"));
  const outputDirectory = resolve(root, "out", "release");
  const nodeBinary = resolve(root, "node");
  const esbuildPackage = `@esbuild/${process.platform}-${process.arch}`;
  const esbuildBinary = resolve(root, "node_modules", esbuildPackage,
    ...(process.platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"]));
  await Promise.all([
    mkdir(resolve(root, "out")),
    mkdir(resolve(root, "node_modules/postject/dist"), { recursive: true }),
    mkdir(resolve(root, "node_modules/esbuild/lib"), { recursive: true }),
    mkdir(resolve(esbuildBinary, ".."), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, "package.json"), JSON.stringify({
      version: "0.1.0-beta.1",
      devDependencies: { esbuild: "0.28.0", postject: "1.0.0-alpha.6" },
    })),
    writeFile(resolve(root, "package-lock.json"), JSON.stringify({ packages: {
      "node_modules/esbuild": {
        version: "0.28.0",
        resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.0.tgz",
        integrity: "sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==",
      },
      "node_modules/postject": {
        version: "1.0.0-alpha.6",
        resolved: "https://registry.npmjs.org/postject/-/postject-1.0.0-alpha.6.tgz",
        integrity: "sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==",
      },
      [`node_modules/${esbuildPackage}`]: { version: "0.28.0", integrity: `sha512-${"A".repeat(86)}==` },
    } })),
    writeFile(resolve(root, "node_modules/postject/dist/cli.js"), "postject\n"),
    writeFile(resolve(root, "node_modules/esbuild/lib/main.js"), "esbuild-library\n"),
    writeFile(esbuildBinary, "esbuild-binary\n"),
    writeFile(nodeBinary, "fixed-node-binary\n"),
  ]);
  const nodeBinaryDigest = digest(Buffer.from("fixed-node-binary\n"));
  const options = { nodeBinary, nodeBinaryDigest, outputDirectory, sourceRevision };
  const invocations = [];
  const execute = async (invocation) => {
    invocations.push(invocation);
    if (invocation.command === "git" && invocation.args.includes("rev-parse")) return `${sourceRevision}\n`;
    if (invocation.command === "git" && invocation.args.includes("status")) return "";
    if (invocation.args[0] === "-p") return JSON.stringify({
      version: "v22.22.0",
      platform: process.platform,
      arch: process.arch,
      execPath: nodeBinary,
    });
    if (invocation.args[0] === "--experimental-sea-config") {
      const config = JSON.parse(await readFile(invocation.args[1], "utf8"));
      await writeFile(config.output, "sea-blob\n");
      return "";
    }
    if (invocation.args[0] === "--identity") {
      const component = invocation.command.includes("testkit") ? "godot-testkit"
        : invocation.command.includes("steam-client-connector") ? "steam-client-connector" : "physical-runner";
      return JSON.stringify(identity(component));
    }
    return "";
  };
  const receipt = await buildRunnerNativeCandidates(options, {
    root,
    execute,
    bundle: async ({ descriptor, outfile }) => {
      await writeFile(outfile, `bundle:${descriptor.component}\n`);
      return { inputCount: descriptor.component === "godot-testkit" ? 10
        : descriptor.component === "physical-runner" ? 20 : 30 };
    },
    now: () => new Date("2026-07-22T00:00:00.000Z"),
    uuid: () => "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(receipt.status, "CANDIDATE");
  assert.equal(receipt.platform, platform);
  assert.equal(receipt.architecture, architecture);
  assert.deepEqual(receipt.artifacts.map(({ component }) => component), [
    "godot-testkit", "physical-runner", "steam-client-connector",
  ]);
  const { outputDirectory: publishedDirectory, ...persistedReceipt } = receipt;
  assert.equal(publishedDirectory, outputDirectory);
  assert.deepEqual(JSON.parse(await readFile(resolve(outputDirectory, "runner-native-build-receipt.json"), "utf8")), persistedReceipt);
  assert.ok(invocations.every((invocation) => !Object.hasOwn(invocation, "shell")));
  assert.ok(invocations.some((invocation) => invocation.args.includes("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2")));
  await assert.rejects(buildRunnerNativeCandidates(options, { root, execute }), /failed validation/);

  assert.deepEqual(parseRunnerNativeBuildArguments([
    "--source-revision", sourceRevision,
    "--output-directory", outputDirectory,
    "--node-binary-digest", nodeBinaryDigest,
    "--node-binary", nodeBinary,
  ]), options);
  assert.throws(() => parseRunnerNativeBuildArguments([
    "--node-binary", "relative-node",
    "--node-binary-digest", nodeBinaryDigest,
    "--output-directory", outputDirectory,
    "--source-revision", sourceRevision,
  ]), /input is invalid/);
});

test("release trust is schema-exact, digest-pinned, Ed25519-only and ships revoked", async () => {
  assert.deepEqual(validateRunnerNativeTrustPolicy(policy, policyDigest), policy);
  const reordered = {
    keys: policy.keys,
    policyRevision: policy.policyRevision,
    policyId: policy.policyId,
    schemaVersion: policy.schemaVersion,
  };
  assert.equal(runnerNativeTrustPolicyDigest(reordered), policyDigest);
  assert.throws(() => validateRunnerNativeTrustPolicy({ ...policy, extra: true }), /trust policy is invalid/);
  assert.throws(() => validateRunnerNativeTrustPolicy(policy, `sha256:${"0".repeat(64)}`), /trust policy is invalid/);
  const template = JSON.parse(await readFile(new URL("../infra/runner-native-trust-policy.example.json", import.meta.url), "utf8"));
  assert.equal(template.keys[0].status, "REVOKED");
  assert.doesNotThrow(() => validateRunnerNativeTrustPolicy(template));
  const inspection = inspectRunnerNativeTrustPolicy(template);
  assert.equal(inspection.keys[0].status, "REVOKED");
  assert.ok(!JSON.stringify(inspection).includes("publicKeySpkiBase64"));
  assert.deepEqual(parseRunnerNativeTrustInspectionArguments([
    "--trust-policy", "/private/reviewed/runner-native-policy.json",
  ]), { trustPolicyPath: "/private/reviewed/runner-native-policy.json" });
  assert.throws(() => parseRunnerNativeTrustInspectionArguments([
    "--trust-policy", "relative.json",
  ]), /input is invalid/);
});

test("target host accepts only a signed release bound to final files, candidate receipt and embedded identities", async () => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "deviludo-native-release-"));
  const bodies = new Map([
    ["godot-testkit", Buffer.from("signed-testkit-binary\n")],
    ["physical-runner", Buffer.from("signed-runner-binary\n")],
    ["steam-client-connector", Buffer.from("signed-steam-connector-binary\n")],
  ]);
  for (const [component, body] of bodies) await writeFile(resolve(artifactDirectory, fileName(component)), body);
  const buildReceipt = buildReceiptFor(bodies);
  assert.deepEqual(validateRunnerNativeBuildReceipt(buildReceipt), buildReceipt);
  const release = signedRelease(buildReceipt, bodies);
  const inspected = [];
  const authorization = await verifyRunnerNativeRelease(release, buildReceipt, policy, policyDigest, {
    artifactDirectory,
    now: new Date("2026-07-22T00:10:00.000Z"),
    inspectIdentity: async ({ artifact }) => {
      inspected.push(artifact.component);
      return identity(artifact.component);
    },
  });
  assert.equal(authorization.status, "VERIFIED");
  assert.equal(authorization.releaseId, release.claims.releaseId);
  assert.equal(authorization.releaseDigest, sha256Canonical(release));
  assert.deepEqual(inspected, ["godot-testkit", "physical-runner", "steam-client-connector"]);

  for (const invalid of [
    { ...release, claims: { ...release.claims, sourceRevision: "b".repeat(40) } },
    { ...release, claims: { ...release.claims, artifacts: release.claims.artifacts.map((artifact, index) =>
      index ? artifact : { ...artifact, releasedDigest: `sha256:${"f".repeat(64)}` }) } },
    { ...release, signature: { ...release.signature, value: `A${release.signature.value.slice(1)}` } },
  ]) {
    await assert.rejects(verifyRunnerNativeRelease(invalid, buildReceipt, policy, policyDigest, {
      artifactDirectory,
      now: new Date("2026-07-22T00:10:00.000Z"),
      inspectIdentity: async ({ artifact }) => identity(artifact.component),
    }), /release is invalid/);
  }
  const revoked = { ...policy, keys: [{ ...policy.keys[0], status: "REVOKED" }] };
  await assert.rejects(verifyRunnerNativeRelease(release, buildReceipt, revoked, runnerNativeTrustPolicyDigest(revoked), {
    artifactDirectory,
    now: new Date("2026-07-22T00:10:00.000Z"),
  }), /release is invalid/);
  await assert.rejects(verifyRunnerNativeRelease(release, buildReceipt, policy, `sha256:${"0".repeat(64)}`, {
    artifactDirectory,
    now: new Date("2026-07-22T00:10:00.000Z"),
  }), /trust policy is invalid/);
});

test("target verifier preserves read-only support for an admitted v1 two-component release", async () => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "deviludo-native-release-v1-"));
  const bodies = new Map([
    ["godot-testkit", Buffer.from("legacy-signed-testkit\n")],
    ["physical-runner", Buffer.from("legacy-signed-runner\n")],
  ]);
  for (const [component, body] of bodies) await writeFile(resolve(artifactDirectory, fileName(component)), body);
  const buildReceipt = buildReceiptFor(bodies, 1);
  const release = signedRelease(buildReceipt, bodies);
  const authorization = await verifyRunnerNativeRelease(release, buildReceipt, policy, policyDigest, {
    artifactDirectory,
    now: new Date("2026-07-22T00:10:00.000Z"),
    inspectIdentity: async ({ artifact }) => identity(artifact.component),
  });
  assert.equal(authorization.schemaVersion, "deviludo.runner-native-install-authorization.v1");
  assert.deepEqual(authorization.artifacts.map(({ component }) => component), ["godot-testkit", "physical-runner"]);
});

test("finalizer hashes native-signed files, verifies identities and obtains one locally verified KMS envelope", async () => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "deviludo-native-final-artifacts-"));
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "deviludo-native-final-evidence-"));
  const bodies = new Map([
    ["godot-testkit", Buffer.from("native-signed-testkit\n")],
    ["physical-runner", Buffer.from("native-signed-runner\n")],
    ["steam-client-connector", Buffer.from("native-signed-steam-connector\n")],
  ]);
  const buildReceipt = buildReceiptFor(bodies);
  for (const candidate of buildReceipt.artifacts) {
    const body = bodies.get(candidate.component);
    await Promise.all([
      writeFile(resolve(artifactDirectory, candidate.fileName), body),
      writeFile(resolve(evidenceDirectory, `${candidate.component}.signing-evidence.json`), JSON.stringify({
        schemaVersion: "deviludo.runner-native-signing-evidence.v1",
        component: candidate.component,
        candidateDigest: candidate.candidateDigest,
        releasedDigest: digest(body),
        sizeBytes: body.length,
        nativeSignature: nativeSignature(candidate.component),
      })),
    ]);
  }
  const claims = await prepareRunnerNativeReleaseClaims(buildReceipt, {
    artifactDirectory,
    evidenceDirectory,
    releaseId: "33333333-3333-4333-8333-333333333333",
    publishedAt: "2026-07-22T00:05:00.000Z",
    inspectIdentity: async ({ component }) => identity(component),
  });
  const calls = [];
  const signer = new MtlsRunnerNativeReleaseSigner({
    endpoint: "https://runner-kms.internal:8443",
    keyId,
    tls: { key: Buffer.alloc(64, 1), cert: Buffer.alloc(64, 2), ca: Buffer.alloc(64, 3) },
    request: async (input) => {
      calls.push(input);
      const body = JSON.parse(input.body);
      return {
        statusCode: 200,
        body: {
          schemaVersion: "deviludo.runner-native-release-signing-response.v2",
          algorithm: "Ed25519",
          keyId,
          claimsDigest: body.claimsDigest,
          signature: sign(null, Buffer.from(body.signingInput, "base64url"), keyPair.privateKey).toString("base64url"),
        },
      };
    },
  });
  const release = await signer.sign(claims, buildReceipt, policy, policyDigest, new Date("2026-07-22T00:10:00.000Z"));
  const verified = verifyRunnerNativeReleaseEnvelope(release, buildReceipt, policy, policyDigest, {
    now: new Date("2026-07-22T00:10:00.000Z"),
  });
  assert.deepEqual(verified.claims, claims);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://runner-kms.internal:8443/v1/runner-native-releases/sign-ed25519");
  assert.equal(calls[0].headers["idempotency-key"], claims.releaseId);
  assert.ok(!calls[0].body.includes("privateKey"));
  await assert.rejects(prepareRunnerNativeReleaseClaims(buildReceipt, {
    artifactDirectory,
    evidenceDirectory,
    releaseId: claims.releaseId,
    publishedAt: claims.publishedAt,
    inspectIdentity: async () => ({ ...identity("godot-testkit"), sourceRevision: "b".repeat(40) }),
  }), /finalization is invalid/);
  assert.throws(() => new MtlsRunnerNativeReleaseSigner({
    endpoint: "http://runner-kms.internal",
    keyId,
    tls: { key: Buffer.alloc(64), cert: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /finalization is invalid/);
});

test("verification CLI requires all absolute files and the reviewed policy digest", () => {
  assert.deepEqual(parseRunnerNativeVerificationArguments([
    "--release", "/private/reviewed/release.json",
    "--artifacts", "/private/reviewed/artifacts",
    "--trust-policy-digest", policyDigest,
    "--build-receipt", "/private/reviewed/build.json",
    "--trust-policy", "/private/reviewed/policy.json",
  ]), {
    artifacts: "/private/reviewed/artifacts",
    buildReceipt: "/private/reviewed/build.json",
    release: "/private/reviewed/release.json",
    trustPolicy: "/private/reviewed/policy.json",
    trustPolicyDigest: policyDigest,
  });
  assert.throws(() => parseRunnerNativeVerificationArguments([
    "--release", "relative.json",
    "--artifacts", "/private/reviewed/artifacts",
    "--trust-policy-digest", policyDigest,
    "--build-receipt", "/private/reviewed/build.json",
    "--trust-policy", "/private/reviewed/policy.json",
  ]), /input is invalid/);
  assert.deepEqual(parseRunnerNativeFinalizationArguments([
    "--output", "/private/reviewed/release.json",
    "--evidence", "/private/reviewed/evidence",
    "--artifacts", "/private/reviewed/artifacts",
    "--release-id", "33333333-3333-4333-8333-333333333333",
    "--published-at", "2026-07-22T00:05:00.000Z",
    "--trust-policy-digest", policyDigest,
    "--build-receipt", "/private/reviewed/build.json",
    "--trust-policy", "/private/reviewed/policy.json",
  ]), {
    artifactDirectory: "/private/reviewed/artifacts",
    buildReceiptPath: "/private/reviewed/build.json",
    evidenceDirectory: "/private/reviewed/evidence",
    outputPath: "/private/reviewed/release.json",
    publishedAt: "2026-07-22T00:05:00.000Z",
    releaseId: "33333333-3333-4333-8333-333333333333",
    trustPolicyPath: "/private/reviewed/policy.json",
    trustPolicyDigest: policyDigest,
  });
});

function buildReceiptFor(bodies, contractVersion = 2) {
  const artifacts = [...bodies].map(([component, body], index) => Object.freeze({
    component,
    fileName: fileName(component),
    candidateDigest: digest(Buffer.from(`candidate:${component}`)),
    sizeBytes: body.length,
    bundleDigest: digest(Buffer.from(`bundle:${component}`)),
    bundleInputCount: index + 10,
    identityDigest: sha256Canonical(identity(component)),
  }));
  return Object.freeze({
    schemaVersion: `deviludo.runner-native-build-receipt.v${contractVersion}`,
    status: "CANDIDATE",
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    platform,
    architecture,
    nodeVersion: "v22.22.0",
    nodeBinaryDigest: digest(Buffer.from("node")),
    packageLockDigest: digest(Buffer.from("lock")),
    esbuildVersion: "0.28.0",
    esbuildLibraryDigest: digest(Buffer.from("esbuild-library")),
    esbuildBinaryDigest: digest(Buffer.from("esbuild-binary")),
    postjectVersion: "1.0.0-alpha.6",
    postjectCliDigest: digest(Buffer.from("postject")),
    signatureState: platform === "macos" ? "ADHOC_BUILD_ONLY"
      : platform === "windows" ? "INVALIDATED_UPSTREAM_SIGNATURE" : "UNSIGNED",
    completedAt: "2026-07-22T00:00:00.000Z",
    artifacts: Object.freeze(artifacts),
  });
}

function signedRelease(buildReceipt, bodies) {
  const contractVersion = buildReceipt.schemaVersion.endsWith(".v2") ? 2 : 1;
  const claims = Object.freeze({
    schemaVersion: `deviludo.runner-native-release-claims.v${contractVersion}`,
    releaseId: "22222222-2222-4222-8222-222222222222",
    buildReceiptDigest: sha256Canonical(buildReceipt),
    platformVersion: buildReceipt.platformVersion,
    sourceRevision: buildReceipt.sourceRevision,
    platform: buildReceipt.platform,
    architecture: buildReceipt.architecture,
    nodeVersion: buildReceipt.nodeVersion,
    publishedAt: "2026-07-22T00:05:00.000Z",
    artifacts: Object.freeze(buildReceipt.artifacts.map((candidate) => {
      const body = bodies.get(candidate.component);
      return Object.freeze({
        component: candidate.component,
        fileName: candidate.fileName,
        candidateDigest: candidate.candidateDigest,
        releasedDigest: digest(body),
        sizeBytes: body.length,
        nativeSignature: Object.freeze(nativeSignature(candidate.component)),
      });
    })),
  });
  return Object.freeze({
    schemaVersion: `deviludo.runner-native-release.v${contractVersion}`,
    claims,
    signature: Object.freeze({
      algorithm: "Ed25519",
      keyId,
      value: sign(null, Buffer.from(canonicalJson(claims)), keyPair.privateKey).toString("base64url"),
    }),
  });
}

function nativeSignature(component) {
  return platform === "macos" ? {
    scheme: "DEVELOPER_ID_NOTARIZED",
    signerIdentity: "Developer-ID:DeviLudo",
    evidenceDigest: digest(Buffer.from(`codesign:${component}`)),
    transparencyLogDigest: null,
    notarizationDigest: digest(Buffer.from(`notary:${component}`)),
  } : platform === "windows" ? {
    scheme: "AUTHENTICODE",
    signerIdentity: "CN:DeviLudo",
    evidenceDigest: digest(Buffer.from(`authenticode:${component}`)),
    transparencyLogDigest: null,
    notarizationDigest: null,
  } : {
    scheme: "SIGSTORE_BUNDLE",
    signerIdentity: "https://github.com/deviludo/runner-release",
    evidenceDigest: digest(Buffer.from(`sigstore:${component}`)),
    transparencyLogDigest: digest(Buffer.from(`rekor:${component}`)),
    notarizationDigest: null,
  };
}

function identity(component) {
  return Object.freeze({
    schemaVersion: "deviludo.native-component-identity.v1",
    component,
    platformVersion: "0.1.0-beta.1",
    sourceRevision,
    nodeVersion: "v22.22.0",
    platform: process.platform,
    architecture: process.arch,
  });
}

function fileName(component) {
  const base = component === "godot-testkit" ? "deviludo-testkit"
    : component === "physical-runner" ? "deviludo-physical-runner" : "deviludo-steam-client-connector";
  return `${base}${platform === "windows" ? ".exe" : ""}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
