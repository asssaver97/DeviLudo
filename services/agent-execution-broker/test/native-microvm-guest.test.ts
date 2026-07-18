import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentExecutionRequest } from "../../agent-worker/src/contracts";
import { signGitHubCandidateArtifact, verifyGitHubCandidateArtifact } from "../../scm-proxy/src/github-artifacts";
import { NativeMicrovmAgentGuest } from "../src/native-microvm-guest";
import { parseNativeMicrovmAgentRequest, type NativeMicrovmAgentRequest } from "../src/native-microvm-contracts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const specRevisionId = "55555555-5555-4555-8555-555555555555";
const testPlanRevisionId = "66666666-6666-4666-8666-666666666666";
const baselineId = "77777777-7777-4777-8777-777777777777";
const model = "gateway/claude-sonnet-4-6-20250514";

test("microVM guest executes the locked adapter and emits an attested authoritative Git delta", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-guest-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(join(workspace, "scripts"), { recursive: true });
    const project = Buffer.from("config_version=5\n[application]\nconfig/name=\"Guest\"\n");
    const executableBefore = Buffer.from("#!/bin/sh\necho before\n");
    const deleted = Buffer.from("remove me\n");
    await Promise.all([writeFile(join(workspace, "project.godot"), project),
      writeFile(join(workspace, "scripts", "tool.sh"), executableBefore), writeFile(join(workspace, "old.txt"), deleted)]);
    if (process.platform !== "win32") await chmod(join(workspace, "scripts", "tool.sh"), 0o700);
    const baselineDigest = treeDigest([{ path: "old.txt", content: deleted, mode: "100644" },
      { path: "project.godot", content: project, mode: "100644" },
      { path: "scripts/tool.sh", content: executableBefore, mode: "100755" }]);
    const keys = generateKeyPairSync("ed25519");
    const observedRuntimes: AgentExecutionRequest[] = [];
    let relayClosed = false;
    const guest = new NativeMicrovmAgentGuest({ relay: { async start() { return Object.freeze({
      gatewayUrl: "https://guest-relay.internal:8443/",
      runTokenSecretRef: `secret://guest-inference-relay/${runId}/${attemptId}`,
      secretResolver: { async resolve() { return "attempt-local-relay-password"; } },
      close: async () => { relayClosed = true; },
    }); } },
      signer: { async sign(core) { return signGitHubCandidateArtifact(core, keys.privateKey, "guest-attestation-v1"); } },
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      supervisor: { async start(input) {
        observedRuntimes.push(input);
        const executableAfter = Buffer.from("#!/bin/sh\necho after\n");
        await Promise.all([writeFile(join(workspace, "scripts", "tool.sh"), executableAfter),
          writeFile(join(workspace, "main.gd"), "extends Node\n"), unlink(join(workspace, "old.txt"))]);
        if (process.platform !== "win32") await chmod(join(workspace, "scripts", "tool.sh"), 0o700);
        return Object.freeze({ cancel: () => false, completion: Promise.resolve(Object.freeze({ status: "completed" as const,
          events: Object.freeze([]), result: Object.freeze({ status: "completed" as const, summary: "done",
            usage: Object.freeze({ inputTokens: 100, outputTokens: 50, costUsd: 0.25 }),
            changedFiles: Object.freeze(["main.gd", "old.txt", "scripts/tool.sh"]), warnings: Object.freeze([]) }),
          diagnostics: Object.freeze({ exitCode: 0, signal: null, timedOut: false, cancelled: false,
            durationMs: 1, stderr: "", droppedJsonLines: 0, adapter: Object.freeze({ eventCount: 1, warningCount: 0, messages: [] }) }) })) });
      } },
    });
    const outcome = await guest.execute({ ...request(baselineDigest),
      // The host may rotate the stable SecretRef before a large source tree
      // reaches the guest; the relay must resolve the current value instead.
      inferenceTokenExpiresAt: "2029-12-31T23:59:00.000Z" }, { runRoot: root, workspaceRoot: workspace });
    assert.equal(outcome.status, "COMPLETED");
    if (outcome.status !== "COMPLETED") assert.fail("expected completed guest result");
    assert.equal(verifyGitHubCandidateArtifact(outcome.candidateArtifact,
      new Map([["guest-attestation-v1", keys.publicKey]])), true);
    assert.deepEqual(outcome.candidateArtifact.payload.changes.map((change) => [change.operation, change.path]), [
      ["UPSERT", "main.gd"], ["DELETE", "old.txt"], ["UPSERT", "scripts/tool.sh"],
    ]);
    const tool = outcome.candidateArtifact.payload.changes[2];
    assert.equal(tool?.operation, "UPSERT");
    if (tool?.operation === "UPSERT") assert.equal(tool.mode, "100755");
    assert.equal(observedRuntimes[0]?.runtimeSpec.env.ANTHROPIC_DEFAULT_OPUS_MODEL, model);
    assert.equal(observedRuntimes[0]?.runtimeSpec.env.ANTHROPIC_BASE_URL, "https://guest-relay.internal:8443");
    assert.equal(observedRuntimes[0]?.runtimeSpec.secretEnv.ANTHROPIC_API_KEY,
      `secret://guest-inference-relay/${runId}/${attemptId}`);
    assert.equal(relayClosed, true);
    assert.equal("providerBaseUrl" in (parseNativeMicrovmAgentRequest(request(baselineDigest)) as object), false);
    assert.equal(await readFile(join(workspace, "main.gd"), "utf8"), "extends Node\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("microVM request rejects mutable fields and guest fails closed when the Agent produces no delta", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-agent-guest-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const project = Buffer.from("config_version=5\n[application]\nconfig/name=\"Guest\"\n");
    await writeFile(join(workspace, "project.godot"), project);
    const baselineDigest = treeDigest([{ path: "project.godot", content: project, mode: "100644" }]);
    assert.throws(() => parseNativeMicrovmAgentRequest({ ...request(baselineDigest),
      providerBaseUrl: "https://third-party.example/" }), /request is invalid/);
    assert.throws(() => parseNativeMicrovmAgentRequest({ ...request(baselineDigest), prompt: "tampered prompt" }), /request is invalid/);
    assert.throws(() => parseNativeMicrovmAgentRequest({ ...request(baselineDigest),
      modelRoles: { ...request(baselineDigest).modelRoles, smallFastModel: "gateway/unauthorized-20250101" } }), /request is invalid/);
    const keys = generateKeyPairSync("ed25519");
    const guest = new NativeMicrovmAgentGuest({ relay: { async start() { return Object.freeze({
      gatewayUrl: "https://guest-relay.internal:8443/", runTokenSecretRef: `secret://guest-inference-relay/${runId}/${attemptId}`,
      secretResolver: { async resolve() { return "attempt-local-relay-password"; } }, close: async () => {},
    }); } },
      signer: { async sign(core) { return signGitHubCandidateArtifact(core, keys.privateKey, "guest-attestation-v1"); } },
      now: () => new Date("2030-01-01T00:00:00.000Z"), supervisor: { async start() { return Object.freeze({ cancel: () => false,
        completion: Promise.resolve(Object.freeze({ status: "completed" as const, events: Object.freeze([]),
          result: Object.freeze({ status: "completed" as const, usage: Object.freeze({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 }),
            changedFiles: Object.freeze([]), warnings: Object.freeze([]) }), diagnostics: Object.freeze({ exitCode: 0, signal: null,
            timedOut: false, cancelled: false, durationMs: 1, stderr: "", droppedJsonLines: 0,
            adapter: Object.freeze({ eventCount: 1, warningCount: 0, messages: [] }) }) })) }); } } });
    const outcome = await guest.execute(request(baselineDigest), { runRoot: root, workspaceRoot: workspace });
    assert.equal(outcome.status, "FAILED");
    assert.match(outcome.diagnosticId ?? "", /^diag-[a-f0-9]{48}$/);
    assert.equal(outcome.candidateArtifact, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function request(sourceDigest: string): NativeMicrovmAgentRequest {
  return Object.freeze({ schemaVersion: "deviludo.native-agent-microvm-request.v1", tenantId, projectId, runId, attemptId,
    resolutionDigest: "a".repeat(64), profileRevisionId: "profile-r1", installationId: "installation-r1",
    imageDigest: `sha256:${"b".repeat(64)}`, exactAgentVersion: "2.1.14", adapterVersion: "adapter-1.0.0",
    agent: "claude-code", providerRevisionId: "provider-r1", providerProtocol: "anthropic-messages",
    credentialVersionId: "credential-v1", model,
    modelRoles: Object.freeze({ primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model }),
    authorizedModels: Object.freeze([model]), budget: Object.freeze({ maxUsd: 10, maxTurns: 50, timeoutSeconds: 600 }),
    specRevisionId, specDigest: "c".repeat(64), testPlanRevisionId, testPlanDigest: "d".repeat(64),
    targetMatrix: ["linux", "windows"] as const, sourceBaselineReceiptId: baselineId,
    baseCommitSha: "e".repeat(40), sourceDigest, inferenceGatewayUrl: "https://inference.internal/",
    inferenceTokenSecretRef: `secret://agent-runs/${runId}/${attemptId}`,
    inferenceTokenExpiresAt: "2030-01-01T00:15:00.000Z",
    inferenceAuthorizationExpiresAt: "2030-01-01T01:00:00.000Z", prompt: "Implement the approved immutable game.",
    promptContentDigest: createHash("sha256").update("Implement the approved immutable game.").digest("hex"),
    promptDigest: "f".repeat(64) });
}

function treeDigest(entries: readonly Readonly<{ path: string; content: Buffer; mode: "100644" | "100755" }>[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))) {
    const blob = createHash("sha1").update(`blob ${entry.content.byteLength}\0`).update(entry.content).digest("hex");
    hash.update(`${entry.mode} blob ${blob}\t${entry.path}\0`);
  }
  return hash.digest("hex");
}
