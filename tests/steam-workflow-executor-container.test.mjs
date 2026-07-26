import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseSteamWorkflowExecutorImageArguments,
  parseSteamWorkflowExecutorImageBuildMetadata,
  steamWorkflowExecutorImageBuildCommand,
  steamWorkflowExecutorImageReceipt,
  validateSteamWorkflowExecutorImageReceipt,
  validateSteamWorkflowExecutorImageSpec,
} from "../scripts/production/build-steam-workflow-executor-image.mjs";
import {
  runSteamWorkflowExecutorContainer,
  validateSteamWorkflowExecutorContainerEnvironment,
} from "../scripts/production/run-steam-workflow-executor-container.mjs";

const packageVersion = "0.1.0-beta.1";
const sourceRevision = "b".repeat(40);
const input = Object.freeze({
  nodeBaseImage: `registry.internal/base/node:22.15.1-bookworm-slim@sha256:${"1".repeat(64)}`,
  nativePublisherImage: `registry.internal/deviludo/native-steam-publisher:1.3.0@sha256:${"5".repeat(64)}`,
  destination: `registry.internal/deviludo/steam-workflow-executor:${packageVersion}-${sourceRevision.slice(0, 12)}`,
  sourceRevision,
  platform: "linux/amd64",
});
const fixedEnvironment = Object.freeze({
  NODE_ENV: "production",
  NODE_OPTIONS: "--enable-source-maps",
  NODE_PATH: "",
  HOME: "/nonexistent",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LD_LIBRARY_PATH: "",
  LD_PRELOAD: "",
  DEVILUDO_CONTAINER_KIND: "steam-workflow-executor",
  DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE: "/opt/deviludo/bin/native-steam-publisher",
  DEVILUDO_STEAM_EXECUTOR_NATIVE_CONFIG_FILE: "/opt/deviludo/config/native-steam-publisher.json",
  DEVILUDO_STEAM_EXECUTOR_WORK_ROOT: "/var/lib/deviludo/steam-publisher",
});

test("Steam workflow executor container starts one fixed external workload", async () => {
  assert.deepEqual(validateSteamWorkflowExecutorContainerEnvironment(fixedEnvironment), fixedEnvironment);
  const calls = [];
  assert.equal(await runSteamWorkflowExecutorContainer({
    argv: [], env: fixedEnvironment,
    launch: async (argv, receivedEnvironment) => calls.push({ argv, receivedEnvironment }),
  }), "steam-workflow-executor");
  assert.deepEqual(calls, [{ argv: ["steam-workflow-executor"], receivedEnvironment: fixedEnvironment }]);
  await assert.rejects(runSteamWorkflowExecutorContainer({ argv: ["steam-access"], env: fixedEnvironment }),
    /arguments are forbidden/);
  assert.throws(() => validateSteamWorkflowExecutorContainerEnvironment({
    ...fixedEnvironment, DEVILUDO_LOCAL_TEST_MODE: "0",
  }), /Local authority is forbidden/);
  assert.throws(() => validateSteamWorkflowExecutorContainerEnvironment({
    ...fixedEnvironment, DEVILUDO_ALLOW_INSECURE_LOCAL_POSTGRES: "0",
  }), /Local authority is forbidden/);
  assert.throws(() => validateSteamWorkflowExecutorContainerEnvironment({
    ...fixedEnvironment, DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE: "/tmp/publisher",
  }), /environment is not fixed/);
  assert.throws(() => validateSteamWorkflowExecutorContainerEnvironment({
    ...fixedEnvironment, NODE_OPTIONS: "--require=/tmp/inject.js",
  }), /environment is not fixed/);
});

test("Steam workflow executor Dockerfile is isolated, non-root and receives native authority only by mount", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile.steam-workflow-executor", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(dockerfile, /^ARG NODE_BASE_IMAGE\nFROM \$\{NODE_BASE_IMAGE\} AS dependencies/m);
  assert.equal((dockerfile.match(/^FROM \$\{NODE_BASE_IMAGE\}/gm) ?? []).length, 2);
  assert.match(dockerfile, /^FROM \$\{NATIVE_PUBLISHER_IMAGE\} AS native-publisher$/m);
  assert.match(dockerfile, /RUN npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile,
    /ENTRYPOINT \["\/usr\/local\/bin\/node", "--import", "tsx", "scripts\/production\/run-steam-workflow-executor-container\.mjs"\]/);
  assert.match(dockerfile, /DEVILUDO_STEAM_EXECUTOR_WORK_ROOT=\/var\/lib\/deviludo\/steam-publisher/);
  assert.doesNotMatch(dockerfile, /COPY .*services\/(?:agent|steam-depot-finalizer|steam-client-connector)/);
  assert.doesNotMatch(dockerfile, /\b(?:curl|wget|apt-get|claude|codex)\b/i);
  assert.match(dockerfile, /COPY --from=native-publisher .*\/opt\/deviludo\/bin\/native-steam-publisher/);
  assert.equal(packageJson.scripts["image:build-steam-workflow-executor"],
    "node scripts/production/build-steam-workflow-executor-image.mjs");
});

test("Steam workflow executor image build pins base, target repository and attestations", () => {
  const spec = validateSteamWorkflowExecutorImageSpec(input, packageVersion);
  assert.deepEqual(spec, { ...input, platformVersion: packageVersion });
  assert.throws(() => validateSteamWorkflowExecutorImageSpec({
    ...input, nodeBaseImage: `registry.internal/base/node:22.14.9-bookworm-slim@sha256:${"1".repeat(64)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateSteamWorkflowExecutorImageSpec({
    ...input, nativePublisherImage: `registry.internal/deviludo/native-steam-publisher:latest@sha256:${"5".repeat(64)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateSteamWorkflowExecutorImageSpec({
    ...input, destination: `registry.internal/deviludo/control-plane:${packageVersion}-${sourceRevision.slice(0, 12)}`,
  }, packageVersion), /input is invalid/);
  assert.throws(() => validateSteamWorkflowExecutorImageSpec({
    ...input, destination: "registry.internal/deviludo/steam-workflow-executor:latest",
  }, packageVersion), /input is invalid/);
  const command = steamWorkflowExecutorImageBuildCommand(spec, "/private/tmp/steam-executor/metadata.json");
  assert.ok(command.args.includes("Dockerfile.steam-workflow-executor"));
  for (const argument of ["--provenance=mode=max", "--sbom=true", "--pull", "--no-cache", "--push"]) {
    assert.ok(command.args.includes(argument));
  }
  assert.ok(command.args.includes(`NODE_BASE_IMAGE=${input.nodeBaseImage}`));
  assert.ok(command.args.includes(`NATIVE_PUBLISHER_IMAGE=${input.nativePublisherImage}`));
  assert.ok(!command.args.includes("--load"));
});

test("Steam workflow executor image receipt revalidates immutable BuildKit output", () => {
  const spec = validateSteamWorkflowExecutorImageSpec(input, packageVersion);
  const imageDigest = `sha256:${"2".repeat(64)}`;
  assert.equal(parseSteamWorkflowExecutorImageBuildMetadata({ "containerimage.digest": imageDigest }), imageDigest);
  assert.throws(() => parseSteamWorkflowExecutorImageBuildMetadata({}), /digest is missing/);
  const expected = {
    nodeBaseImage: input.nodeBaseImage,
    nativePublisherImage: input.nativePublisherImage,
    dockerfileDigest: `sha256:${"3".repeat(64)}`,
    packageLockDigest: `sha256:${"4".repeat(64)}`,
    sourceRevision,
    platform: input.platform,
    platformVersion: packageVersion,
  };
  const receipt = steamWorkflowExecutorImageReceipt(spec, { "containerimage.digest": imageDigest }, expected,
    "2026-07-26T08:00:00.000Z");
  assert.deepEqual(validateSteamWorkflowExecutorImageReceipt(receipt, expected), receipt);
  assert.equal(receipt.imageReference, `registry.internal/deviludo/steam-workflow-executor@${imageDigest}`);
  assert.throws(() => validateSteamWorkflowExecutorImageReceipt({ ...receipt, packageLockDigest: `sha256:${"9".repeat(64)}` }, expected),
    /receipt is invalid/);
});

test("Steam workflow executor image CLI rejects missing, duplicate and unknown values", () => {
  assert.deepEqual(parseSteamWorkflowExecutorImageArguments([
    "--node-base-image", input.nodeBaseImage, "--native-publisher-image", input.nativePublisherImage,
    "--destination", input.destination, "--source-revision", sourceRevision,
  ], packageVersion), { ...input, platformVersion: packageVersion });
  assert.throws(() => parseSteamWorkflowExecutorImageArguments(["--unknown", "value"], packageVersion), /input is invalid/);
  assert.throws(() => parseSteamWorkflowExecutorImageArguments([
    "--node-base-image", input.nodeBaseImage, "--node-base-image", input.nodeBaseImage,
  ], packageVersion), /input is invalid/);
});
