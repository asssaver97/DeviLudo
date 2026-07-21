import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SERVICE_ENTRYPOINTS } from "../scripts/observability/run-service.mjs";
import {
  controlPlaneBuildCommand,
  controlPlaneImageReceipt,
  parseControlPlaneBuildMetadata,
  parseControlPlaneImageArguments,
  validateControlPlaneImageSpec,
} from "../scripts/production/build-control-plane-image.mjs";
import {
  assertContainerServiceClassification,
  CONTROL_PLANE_CONTAINER_SERVICES,
  EXTERNAL_WORKLOAD_SERVICES,
  resolveControlPlaneContainerService,
  runControlPlaneContainer,
} from "../scripts/production/run-control-service.mjs";

const sourceRevision = "b".repeat(40);
const packageVersion = "0.1.0-beta.1";
const validInput = Object.freeze({
  baseImage: `registry.internal/base/node:22.13.1-bookworm-slim@sha256:${"a".repeat(64)}`,
  destination: `registry.internal/deviludo/control-plane:${packageVersion}-${sourceRevision.slice(0, 12)}`,
  sourceRevision,
  platform: "linux/amd64",
});

test("every process entrypoint is explicitly classified into the shared control image or an external workload", () => {
  const classification = assertContainerServiceClassification();
  assert.deepEqual(
    [...classification.control, ...classification.external].sort(),
    Object.keys(SERVICE_ENTRYPOINTS).sort(),
  );
  assert.equal(new Set([...classification.control, ...classification.external]).size, Object.keys(SERVICE_ENTRYPOINTS).length);
  for (const service of [
    "agent-execution-worker", "agent-microvm-guest", "physical-runner", "godot-testkit",
    "steam-workflow-executor", "steam-depot-finalizer", "steam-client-connector", "web",
  ]) {
    assert.ok(EXTERNAL_WORKLOAD_SERVICES.includes(service));
    assert.ok(!CONTROL_PLANE_CONTAINER_SERVICES.includes(service));
  }
  assert.throws(
    () => assertContainerServiceClassification({ ...SERVICE_ENTRYPOINTS, unclassified: { entry: "unsafe.ts" } }),
    /classification is incomplete/,
  );
});

test("container entrypoint permits one fixed production control service without runtime arguments", async () => {
  const env = Object.freeze({ NODE_ENV: "production", DEVILUDO_SERVICE: "control-plane" });
  assert.equal(resolveControlPlaneContainerService(env), "control-plane");
  const calls = [];
  assert.equal(await runControlPlaneContainer({
    argv: [],
    env,
    launch: async (argv, receivedEnvironment) => calls.push({ argv, receivedEnvironment }),
  }), "control-plane");
  assert.deepEqual(calls, [{ argv: ["control-plane"], receivedEnvironment: env }]);

  await assert.rejects(runControlPlaneContainer({ argv: ["identity"], env, launch: async () => undefined }), /arguments are forbidden/);
  assert.throws(() => resolveControlPlaneContainerService({ ...env, DEVILUDO_SERVICE: "physical-runner" }), /not allow-listed/);
  assert.throws(() => resolveControlPlaneContainerService({ ...env, NODE_ENV: "development" }), /production mode/);
  assert.throws(() => resolveControlPlaneContainerService({ ...env, DEVILUDO_LOCAL_TEST_MODE: "0" }), /Local test authority/);
  assert.throws(
    () => resolveControlPlaneContainerService({ ...env, DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION: "0" }),
    /Local test authority/,
  );
});

test("control-plane Dockerfile has a mandatory pinned base, production-only dependencies and a non-root fixed entrypoint", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile.control-plane", import.meta.url), "utf8");
  const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(dockerfile, /^ARG NODE_BASE_IMAGE\nFROM \$\{NODE_BASE_IMAGE\} AS dependencies/m);
  assert.equal((dockerfile.match(/^FROM \$\{NODE_BASE_IMAGE\}/gm) ?? []).length, 2);
  assert.match(dockerfile, /RUN npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /ENTRYPOINT \["node", "--import", "tsx", "scripts\/production\/run-control-service\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /\b(?:curl|wget|claude|codex|steamcmd|godot)\b/i);
  assert.match(dockerignore, /^\*\*$/m);
  assert.match(dockerignore, /!infra\/postgres\/\*\*/);
  assert.match(dockerignore, /\*\*\/\.env\.\*/);
  assert.match(dockerignore, /\*\*\/test\/\*\*/);
  assert.equal(packageJson.dependencies.tsx, "4.22.1");
  assert.equal(packageJson.devDependencies.tsx, undefined);
  assert.equal(packageJson.scripts["image:build-control"], "node scripts/production/build-control-plane-image.mjs");
});

test("image build accepts only a digest-pinned Node base and an immutable source-derived destination tag", () => {
  const spec = validateControlPlaneImageSpec(validInput, packageVersion);
  assert.deepEqual(spec, { ...validInput, packageVersion });
  assert.throws(() => validateControlPlaneImageSpec({ ...validInput, baseImage: "node:22-bookworm-slim" }, packageVersion), /input is invalid/);
  assert.throws(() => validateControlPlaneImageSpec({
    ...validInput,
    baseImage: `registry.internal/base/node:22.12.0-bookworm-slim@sha256:${"a".repeat(64)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateControlPlaneImageSpec({
    ...validInput,
    baseImage: `registry.internal/base/python:22.13.1-bookworm-slim@sha256:${"a".repeat(64)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateControlPlaneImageSpec({
    ...validInput,
    destination: "registry.internal/deviludo/control-plane:latest",
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateControlPlaneImageSpec({
    ...validInput,
    destination: `operator:password@registry.internal/deviludo/control-plane:${packageVersion}-${sourceRevision.slice(0, 12)}`,
  }, packageVersion), /input is invalid/);
});

test("BuildKit command always pushes one platform with fresh provenance and an SBOM", () => {
  const spec = validateControlPlaneImageSpec(validInput, packageVersion);
  const build = controlPlaneBuildCommand(spec, "/private/tmp/control-image/metadata.json");
  assert.equal(build.command, "docker");
  assert.deepEqual(build.args.slice(0, 2), ["buildx", "build"]);
  for (const argument of ["--provenance=mode=max", "--sbom=true", "--pull", "--no-cache", "--push"]) {
    assert.ok(build.args.includes(argument));
  }
  assert.ok(build.args.includes(`NODE_BASE_IMAGE=${validInput.baseImage}`));
  assert.ok(build.args.includes(`DEVILUDO_SOURCE_REVISION=${sourceRevision}`));
  assert.ok(!build.args.includes("--load"));
  assert.throws(() => controlPlaneBuildCommand(spec, "relative-metadata.json"), /input is invalid/);
});

test("build receipt is bound to the final registry digest, source, Dockerfile and lockfile", () => {
  const spec = validateControlPlaneImageSpec(validInput, packageVersion);
  const imageDigest = `sha256:${"c".repeat(64)}`;
  assert.equal(parseControlPlaneBuildMetadata({ "containerimage.digest": imageDigest }), imageDigest);
  assert.throws(() => parseControlPlaneBuildMetadata({}), /digest is missing/);
  const receipt = controlPlaneImageReceipt(spec, { "containerimage.digest": imageDigest }, {
    dockerfileDigest: `sha256:${"d".repeat(64)}`,
    packageLockDigest: `sha256:${"e".repeat(64)}`,
  }, "2026-07-22T00:00:00.000Z");
  assert.equal(receipt.imageReference, `registry.internal/deviludo/control-plane@${imageDigest}`);
  assert.deepEqual(receipt.attestations, ["buildkit-provenance-mode-max", "buildkit-sbom"]);
  assert.equal(receipt.sourceRevision, sourceRevision);
});

test("image build CLI rejects unknown, missing and duplicate options before invoking Docker", () => {
  assert.deepEqual(parseControlPlaneImageArguments([
    "--base-image", validInput.baseImage,
    "--destination", validInput.destination,
    "--source-revision", sourceRevision,
  ], packageVersion), { ...validInput, packageVersion });
  assert.throws(() => parseControlPlaneImageArguments(["--unknown", "value"], packageVersion), /input is invalid/);
  assert.throws(() => parseControlPlaneImageArguments([
    "--base-image", validInput.baseImage,
    "--base-image", validInput.baseImage,
    "--destination", validInput.destination,
    "--source-revision", sourceRevision,
  ], packageVersion), /input is invalid/);
});
