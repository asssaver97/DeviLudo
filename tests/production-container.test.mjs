import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SERVICE_ENTRYPOINTS } from "../scripts/observability/run-service.mjs";
import {
  agentSupplyChainImageBuildCommand,
  agentSupplyChainImageReceipt,
  parseAgentSupplyChainImageArguments,
  validateAgentSupplyChainImageReceipt,
  validateAgentSupplyChainImageSpec,
} from "../scripts/production/build-agent-supply-chain-image.mjs";
import {
  runAgentSupplyChainContainer,
  validateAgentSupplyChainContainerEnvironment,
} from "../scripts/production/run-agent-supply-chain-container.mjs";
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
const agentSupplyChainInput = Object.freeze({
  nodeBaseImage: `registry.internal/base/node:22.13.1-bookworm-slim@sha256:${"1".repeat(64)}`,
  toolchainBaseImage: `registry.internal/deviludo/agent-supply-chain-toolchain:${packageVersion}@sha256:${"2".repeat(64)}`,
  destination: `registry.internal/deviludo/agent-supply-chain:${packageVersion}-${sourceRevision.slice(0, 12)}`,
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
    "agent-execution-worker", "agent-microvm-guest", "agent-supply-chain", "physical-runner", "godot-testkit",
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

test("Agent supply-chain container has one fixed production workload and rejects local authority", async () => {
  const env = Object.freeze({
    NODE_ENV: "production",
    NODE_OPTIONS: "--enable-source-maps",
    NODE_PATH: "",
    HOME: "/nonexistent",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LD_LIBRARY_PATH: "",
    LD_PRELOAD: "",
    DEVILUDO_CONTAINER_KIND: "agent-supply-chain",
  });
  assert.deepEqual(validateAgentSupplyChainContainerEnvironment(env), env);
  const calls = [];
  assert.equal(await runAgentSupplyChainContainer({
    env,
    argv: [],
    launch: async (argv, receivedEnvironment) => calls.push({ argv, receivedEnvironment }),
  }), "agent-supply-chain");
  assert.deepEqual(calls, [{ argv: ["agent-supply-chain"], receivedEnvironment: env }]);
  await assert.rejects(runAgentSupplyChainContainer({ env, argv: ["control-plane"] }), /arguments are forbidden/);
  assert.throws(() => validateAgentSupplyChainContainerEnvironment({ ...env, NODE_ENV: "development" }), /image identity/);
  assert.throws(() => validateAgentSupplyChainContainerEnvironment({ ...env, DEVILUDO_LOCAL_TEST_MODE: "0" }), /Local test authority/);
  assert.throws(() => validateAgentSupplyChainContainerEnvironment({
    ...env,
    DEVILUDO_LOCAL_AGENT_EXECUTION: "0",
  }), /Local test authority/);
  assert.throws(() => validateAgentSupplyChainContainerEnvironment({ ...env, NODE_OPTIONS: "--require=/tmp/inject.js" }),
    /process environment is not fixed/);
  assert.throws(() => validateAgentSupplyChainContainerEnvironment({ ...env, LD_PRELOAD: "/opt/deviludo/inject.so" }),
    /process environment is not fixed/);
});

test("Agent supply-chain Dockerfile is a dedicated digest-pinned toolchain carrier", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile.agent-supply-chain", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(dockerfile, /^ARG NODE_BASE_IMAGE\nFROM \$\{NODE_BASE_IMAGE\} AS dependencies/m);
  assert.match(dockerfile, /^ARG TOOLCHAIN_BASE_IMAGE\nFROM \$\{TOOLCHAIN_BASE_IMAGE\} AS runtime/m);
  assert.equal((dockerfile.match(/^FROM /gm) ?? []).length, 2);
  assert.match(dockerfile, /RUN npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/node", "scripts\/production\/run-agent-supply-chain-container\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /\b(?:curl|wget|npm install|claude|codex|steamcmd|godot)\b/i);
  assert.equal(packageJson.scripts["image:build-agent-supply-chain"],
    "node scripts/production/build-agent-supply-chain-image.mjs");
});

test("Agent supply-chain image build binds two digest-pinned bases and a source-derived destination", () => {
  const spec = validateAgentSupplyChainImageSpec(agentSupplyChainInput, packageVersion);
  assert.deepEqual(spec, { ...agentSupplyChainInput, platformVersion: packageVersion });
  assert.throws(() => validateAgentSupplyChainImageSpec({
    ...agentSupplyChainInput,
    toolchainBaseImage: `registry.internal/deviludo/agent-supply-chain-toolchain:latest@sha256:${"2".repeat(64)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateAgentSupplyChainImageSpec({
    ...agentSupplyChainInput,
    toolchainBaseImage: `registry.internal/deviludo/agent-supply-chain-toolchain:0.2.0@sha256:${"2".repeat(64)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateAgentSupplyChainImageSpec({
    ...agentSupplyChainInput,
    destination: `registry.internal/deviludo/control-plane:${packageVersion}-${sourceRevision.slice(0, 12)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateAgentSupplyChainImageSpec({
    ...agentSupplyChainInput,
    toolchainBaseImage: `registry.internal/deviludo/control-plane:${packageVersion}@sha256:${"2".repeat(64)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateAgentSupplyChainImageSpec({
    ...agentSupplyChainInput,
    nodeBaseImage: `registry.internal/base/node:22.12.9-bookworm-slim@sha256:${"1".repeat(64)}`,
  }, packageVersion), /input is invalid/);
  const build = agentSupplyChainImageBuildCommand(spec, "/private/tmp/agent-supply-chain/metadata.json");
  for (const argument of ["--provenance=mode=max", "--sbom=true", "--pull", "--no-cache", "--push"]) {
    assert.ok(build.args.includes(argument));
  }
  assert.ok(build.args.includes(`TOOLCHAIN_BASE_IMAGE=${agentSupplyChainInput.toolchainBaseImage}`));
  assert.ok(!build.args.includes("--load"));
});

test("Agent supply-chain image receipt revalidates exact build inputs", () => {
  const spec = validateAgentSupplyChainImageSpec(agentSupplyChainInput, packageVersion);
  const imageDigest = `sha256:${"3".repeat(64)}`;
  const expected = {
    dockerfileDigest: `sha256:${"4".repeat(64)}`,
    packageLockDigest: `sha256:${"5".repeat(64)}`,
    nodeBaseImage: agentSupplyChainInput.nodeBaseImage,
    toolchainBaseImage: agentSupplyChainInput.toolchainBaseImage,
    sourceRevision,
    platform: agentSupplyChainInput.platform,
    platformVersion: packageVersion,
  };
  const receipt = agentSupplyChainImageReceipt(spec, { "containerimage.digest": imageDigest }, expected,
    "2026-07-24T00:00:00.000Z");
  assert.deepEqual(validateAgentSupplyChainImageReceipt(receipt, expected), receipt);
  assert.equal(receipt.imageReference, `registry.internal/deviludo/agent-supply-chain@${imageDigest}`);
  assert.throws(() => validateAgentSupplyChainImageReceipt({ ...receipt, sourceRevision: "9".repeat(40) }, expected),
    /receipt is invalid/);
  assert.throws(() => validateAgentSupplyChainImageReceipt({
    ...receipt,
    toolchainBaseImage: `registry.internal/deviludo/agent-supply-chain-toolchain:0.2.0@sha256:${"2".repeat(64)}`,
  }, expected), /receipt is invalid/);
});

test("Agent supply-chain image CLI rejects missing, duplicate and unknown values", () => {
  assert.deepEqual(parseAgentSupplyChainImageArguments([
    "--node-base-image", agentSupplyChainInput.nodeBaseImage,
    "--toolchain-base-image", agentSupplyChainInput.toolchainBaseImage,
    "--destination", agentSupplyChainInput.destination,
    "--source-revision", sourceRevision,
  ], packageVersion), { ...agentSupplyChainInput, platformVersion: packageVersion });
  assert.throws(() => parseAgentSupplyChainImageArguments(["--unknown", "value"], packageVersion), /input is invalid/);
  assert.throws(() => parseAgentSupplyChainImageArguments([
    "--node-base-image", agentSupplyChainInput.nodeBaseImage,
    "--node-base-image", agentSupplyChainInput.nodeBaseImage,
  ], packageVersion), /input is invalid/);
});
