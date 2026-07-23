import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalRuntimeRequestError,
  LocalRuntimeRunCoordinator,
  localRuntimeRunBinding,
  parseLocalRuntimeRequest,
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
