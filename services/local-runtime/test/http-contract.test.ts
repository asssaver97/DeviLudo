import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalMainGateCoordinator,
  LocalRuntimeRequestError,
  LocalRuntimeRunCoordinator,
  LocalSteamReinstallCoordinator,
  localRuntimeRunBinding,
  parseLocalMainGateRequest,
  parseLocalRuntimeRequest,
  parseLocalSteamReinstallRequest,
} from "../src/http-contract";

function parse(value: unknown) {
  return parseLocalRuntimeRequest(Buffer.from(JSON.stringify(value)));
}

test("parses an exact immutable local runtime request", () => {
  const request = parse({
    projectId: "project-http",
    runId: "RUN-HTTP-001",
    specRevisionId: "SPEC-HTTP-001",
    targetMatrix: ["macos", "linux"],
  });
  assert.deepEqual(request.targetMatrix, ["macos", "linux"]);
  assert.equal(
    localRuntimeRunBinding(request),
    '["project-http","RUN-HTTP-001","SPEC-HTTP-001","macos","linux"]',
  );
});

test("rejects malformed bodies and ambiguous target matrices as client errors", () => {
  for (const body of [
    Buffer.from("null"),
    Buffer.from("{"),
    Buffer.from(JSON.stringify({ projectId: "project-http", runId: "RUN-HTTP-001", specRevisionId: "SPEC-HTTP-001", targetMatrix: [] })),
    Buffer.from(JSON.stringify({ projectId: "project-http", runId: "RUN-HTTP-001", specRevisionId: "SPEC-HTTP-001", targetMatrix: ["linux", "linux"] })),
    Buffer.from(JSON.stringify({ projectId: "project-http", runId: "RUN-HTTP-001", specRevisionId: "SPEC-HTTP-001", targetMatrix: ["android"] })),
    Buffer.from(JSON.stringify({ projectId: "project-http", runId: "RUN-HTTP-001", specRevisionId: "SPEC-HTTP-001", targetMatrix: ["linux"], extra: true })),
  ]) {
    assert.throws(
      () => parseLocalRuntimeRequest(body),
      (error) => error instanceof LocalRuntimeRequestError
        && error.status === 400
        && error.code === "INVALID_REQUEST",
    );
  }
});

test("the immutable run binding changes with either the spec or ordered matrix", () => {
  const base = parse({
    projectId: "project-http",
    runId: "RUN-HTTP-001",
    specRevisionId: "SPEC-HTTP-001",
    targetMatrix: ["linux", "macos"],
  });
  assert.notEqual(
    localRuntimeRunBinding(base),
    localRuntimeRunBinding({ ...base, specRevisionId: "SPEC-HTTP-002" }),
  );
  assert.notEqual(
    localRuntimeRunBinding(base),
    localRuntimeRunBinding({ ...base, targetMatrix: ["macos", "linux"] }),
  );
});

test("an active run deduplicates the exact binding and rejects a conflicting claimant", async () => {
  const coordinator = new LocalRuntimeRunCoordinator<string>();
  const request = parse({
    projectId: "project-http",
    runId: "RUN-HTTP-001",
    specRevisionId: "SPEC-HTTP-001",
    targetMatrix: ["linux"],
  });
  let finish!: (value: string) => void;
  let executions = 0;
  const first = coordinator.start(request, () => {
    executions += 1;
    return new Promise<string>((resolve) => { finish = resolve; });
  });
  const duplicate = coordinator.start(request, async () => {
    executions += 1;
    return "wrong";
  });
  assert.equal(duplicate, first);
  assert.equal(executions, 1);
  assert.throws(
    () => coordinator.start({ ...request, targetMatrix: ["windows"] }, async () => "wrong"),
    (error) => error instanceof LocalRuntimeRequestError
      && error.status === 409
      && error.code === "RUN_BINDING_CONFLICT",
  );
  finish("complete");
  assert.equal(await duplicate, "complete");

  assert.equal(await coordinator.start({ ...request, targetMatrix: ["windows"] }, async () => "successor"), "successor");
  assert.equal(executions, 1);
});

test("main gate parsing and coordination bind the exact accepted candidate evidence", async () => {
  const request = parseLocalMainGateRequest(Buffer.from(JSON.stringify({
    projectId: "project-http",
    runId: "RUN-HTTP-001",
    specRevisionId: "SPEC-HTTP-001",
    targetMatrix: ["macos"],
    candidateEvidenceId: "EV-LOCAL-ABCDEF123456",
    candidateBundleDigest: "a".repeat(64),
    candidateSha: "b".repeat(40),
    sourceDigest: "c".repeat(64),
  })));
  const coordinator = new LocalMainGateCoordinator<string>();
  let finish!: (value: string) => void;
  const first = coordinator.start(request, () => new Promise<string>((resolve) => { finish = resolve; }));
  assert.equal(coordinator.start(request, async () => "wrong"), first);
  assert.throws(
    () => coordinator.start({ ...request, candidateSha: "d".repeat(40) }, async () => "wrong"),
    (error) => error instanceof LocalRuntimeRequestError && error.code === "RUN_BINDING_CONFLICT",
  );
  finish("complete");
  assert.equal(await first, "complete");
  assert.throws(
    () => parseLocalMainGateRequest(Buffer.from(JSON.stringify({ ...request, candidateSha: "short" }))),
    (error) => error instanceof LocalRuntimeRequestError && error.code === "INVALID_REQUEST",
  );
});

test("local Steam reinstall parsing and coordination freeze main, artifact and MFA bindings", async () => {
  const request = parseLocalSteamReinstallRequest(Buffer.from(JSON.stringify({
    projectId: "project-http",
    runId: "RUN-HTTP-001",
    specRevisionId: "SPEC-HTTP-001",
    targetMatrix: ["macos"],
    mainEvidenceId: "EV-MAIN-ABCDEF123456",
    mainBundleDigest: "a".repeat(64),
    mainSha: "b".repeat(40),
    mainSourceDigest: "c".repeat(64),
    mainArtifactSha256: "d".repeat(64),
    mfaApprovalId: "MFA-LOCAL-0012",
  })));
  const coordinator = new LocalSteamReinstallCoordinator<string>();
  let finish!: (value: string) => void;
  const first = coordinator.start(request, () => new Promise<string>((resolve) => { finish = resolve; }));
  assert.equal(coordinator.start(request, async () => "wrong"), first);
  assert.throws(
    () => coordinator.start({ ...request, mainArtifactSha256: "e".repeat(64) }, async () => "wrong"),
    (error) => error instanceof LocalRuntimeRequestError && error.code === "RUN_BINDING_CONFLICT",
  );
  finish("complete");
  assert.equal(await first, "complete");
  assert.throws(
    () => parseLocalSteamReinstallRequest(Buffer.from(JSON.stringify({ ...request, targetMatrix: ["linux"] }))),
    (error) => error instanceof LocalRuntimeRequestError && error.code === "INVALID_REQUEST",
  );
});
