import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  agentMicrovmCredentialIssuerImageBuildCommand,
  agentMicrovmCredentialIssuerImageReceipt,
  parseAgentMicrovmCredentialIssuerImageArguments,
  validateAgentMicrovmCredentialIssuerImageReceipt,
  validateAgentMicrovmCredentialIssuerImageSpec,
} from "../scripts/production/build-agent-microvm-credential-issuer-image.mjs";
import {
  runAgentMicrovmCredentialIssuerContainer,
  validateAgentMicrovmCredentialIssuerContainerEnvironment,
} from "../scripts/production/run-agent-microvm-credential-issuer-container.mjs";

const sourceRevision = "7".repeat(40);
const platformVersion = "0.1.0-beta.1";
const input = Object.freeze({
  nodeBaseImage: `registry.internal/base/node:22.13.1-bookworm-slim@sha256:${"1".repeat(64)}`,
  toolchainBaseImage: `registry.internal/deviludo/agent-microvm-credential-toolchain:${platformVersion}@sha256:${"2".repeat(64)}`,
  destination: `registry.internal/deviludo/agent-microvm-credential-issuer:${platformVersion}-${sourceRevision.slice(0, 12)}`,
  sourceRevision,
  platform: "linux/amd64",
});

const containerEnvironment = Object.freeze({
  NODE_ENV: "production",
  NODE_OPTIONS: "--enable-source-maps",
  NODE_PATH: "",
  HOME: "/nonexistent",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LD_LIBRARY_PATH: "",
  LD_PRELOAD: "",
  DEVILUDO_CONTAINER_KIND: "agent-microvm-credential-issuer",
  DEVILUDO_GUEST_CREDENTIAL_ISSUER_WORK_ROOT: "/run/deviludo-credential-images",
  DEVILUDO_GUEST_CREDENTIAL_ISSUER_MKE2FS_EXECUTABLE: "/usr/sbin/mke2fs",
});

test("credential issuer container has one fixed workload and memory-backed image path", async () => {
  assert.deepEqual(validateAgentMicrovmCredentialIssuerContainerEnvironment(containerEnvironment), containerEnvironment);
  const calls = [];
  assert.equal(await runAgentMicrovmCredentialIssuerContainer({
    argv: [], env: containerEnvironment,
    launch: async (argv, env) => calls.push({ argv, env }),
  }), "agent-microvm-credential-issuer");
  assert.deepEqual(calls, [{ argv: ["agent-microvm-credential-issuer"], env: containerEnvironment }]);
  await assert.rejects(runAgentMicrovmCredentialIssuerContainer({
    argv: ["agent-execution-worker"], env: containerEnvironment,
  }), /arguments are forbidden/);
  assert.throws(() => validateAgentMicrovmCredentialIssuerContainerEnvironment({
    ...containerEnvironment, DEVILUDO_GUEST_CREDENTIAL_ISSUER_WORK_ROOT: "/tmp",
  }), /environment is not fixed/);
  assert.throws(() => validateAgentMicrovmCredentialIssuerContainerEnvironment({
    ...containerEnvironment, DEVILUDO_LOCAL_TEST_MODE: "0",
  }), /Local test authority/);
});

test("credential issuer Dockerfile is a dedicated non-root digest-pinned toolchain carrier", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile.agent-microvm-credential-issuer", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(dockerfile, /^ARG NODE_BASE_IMAGE\nFROM \$\{NODE_BASE_IMAGE\} AS dependencies/m);
  assert.match(dockerfile, /^ARG TOOLCHAIN_BASE_IMAGE\nFROM \$\{TOOLCHAIN_BASE_IMAGE\} AS runtime/m);
  assert.equal((dockerfile.match(/^FROM /gm) ?? []).length, 2);
  assert.match(dockerfile, /RUN npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.match(dockerfile, /DEVILUDO_GUEST_CREDENTIAL_ISSUER_MKE2FS_EXECUTABLE=\/usr\/sbin\/mke2fs/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/node", "scripts\/production\/run-agent-microvm-credential-issuer-container\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /\b(?:curl|wget|npm install|claude|codex|steamcmd|godot)\b/i);
  assert.equal(packageJson.scripts["image:build-agent-microvm-credential-issuer"],
    "node scripts/production/build-agent-microvm-credential-issuer-image.mjs");
});

test("credential issuer image build accepts only fixed bases and source-derived tags", () => {
  const spec = validateAgentMicrovmCredentialIssuerImageSpec(input, platformVersion);
  assert.deepEqual(spec, { ...input, platformVersion });
  assert.throws(() => validateAgentMicrovmCredentialIssuerImageSpec({
    ...input, toolchainBaseImage: `registry.internal/deviludo/agent-microvm-credential-toolchain:latest@sha256:${"2".repeat(64)}`,
  }, platformVersion), /input is invalid/);
  assert.throws(() => validateAgentMicrovmCredentialIssuerImageSpec({
    ...input, destination: "registry.internal/deviludo/agent-microvm-credential-issuer:latest",
  }, platformVersion), /input is invalid/);
  assert.throws(() => validateAgentMicrovmCredentialIssuerImageSpec({
    ...input, toolchainBaseImage: `registry.internal/deviludo/agent-supply-chain-toolchain:${platformVersion}@sha256:${"2".repeat(64)}`,
  }, platformVersion), /input is invalid/);
  const command = agentMicrovmCredentialIssuerImageBuildCommand(spec, "/private/tmp/credential-issuer/metadata.json");
  assert.ok(command.args.includes(`TOOLCHAIN_BASE_IMAGE=${input.toolchainBaseImage}`));
  for (const argument of ["--provenance=mode=max", "--sbom=true", "--pull", "--no-cache", "--push"]) {
    assert.ok(command.args.includes(argument));
  }
  assert.ok(!command.args.includes("--load"));
});

test("credential issuer image receipt binds immutable build inputs", () => {
  const spec = validateAgentMicrovmCredentialIssuerImageSpec(input, platformVersion);
  const expected = Object.freeze({
    dockerfileDigest: `sha256:${"4".repeat(64)}`,
    packageLockDigest: `sha256:${"5".repeat(64)}`,
    nodeBaseImage: input.nodeBaseImage,
    toolchainBaseImage: input.toolchainBaseImage,
    sourceRevision,
    platform: input.platform,
    platformVersion,
  });
  const imageDigest = `sha256:${"3".repeat(64)}`;
  const receipt = agentMicrovmCredentialIssuerImageReceipt(spec,
    { "containerimage.digest": imageDigest }, expected, "2026-07-26T00:00:00.000Z");
  assert.deepEqual(validateAgentMicrovmCredentialIssuerImageReceipt(receipt, expected), receipt);
  assert.equal(receipt.imageReference, `registry.internal/deviludo/agent-microvm-credential-issuer@${imageDigest}`);
  assert.throws(() => validateAgentMicrovmCredentialIssuerImageReceipt({
    ...receipt, toolchainBaseImage: `registry.internal/deviludo/agent-microvm-credential-toolchain:0.2.0@sha256:${"2".repeat(64)}`,
  }, expected), /receipt is invalid/);
});

test("credential issuer image CLI rejects missing, duplicate and unknown arguments", () => {
  assert.deepEqual(parseAgentMicrovmCredentialIssuerImageArguments([
    "--node-base-image", input.nodeBaseImage,
    "--toolchain-base-image", input.toolchainBaseImage,
    "--destination", input.destination,
    "--source-revision", sourceRevision,
  ], platformVersion), { ...input, platformVersion });
  assert.throws(() => parseAgentMicrovmCredentialIssuerImageArguments(["--unknown", "value"], platformVersion),
    /input is invalid/);
  assert.throws(() => parseAgentMicrovmCredentialIssuerImageArguments([
    "--node-base-image", input.nodeBaseImage, "--node-base-image", input.nodeBaseImage,
  ], platformVersion), /input is invalid/);
});
