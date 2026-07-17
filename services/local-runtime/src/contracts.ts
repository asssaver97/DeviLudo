export type LocalRuntimeRequest = {
  projectId: string;
  runId: string;
  specRevisionId: string;
};

export type LocalRuntimeCheck = {
  name: "import" | "boot" | "core-loop" | "save-load" | "performance" | "macos-export";
  status: "PASSED" | "FAILED" | "WAITING_DEPENDENCY";
  durationMs: number;
  detail: string;
};

export type LocalRuntimeEvidence = {
  schemaVersion: 1;
  evidenceId: string;
  projectId: string;
  runId: string;
  specRevisionId: string;
  platform: "macos";
  status: "TESTS_PASSED" | "FAILED";
  releaseGate: "WAITING_EXPORT_TEMPLATES" | "LOCAL_VALIDATION_PASSED" | "TESTS_FAILED";
  candidateSha: string;
  sourceDigest: string;
  bundleDigest: string;
  godotVersion: string;
  checks: LocalRuntimeCheck[];
  artifacts: Array<"manifest.json" | "junit.xml" | "godot.log">;
  artifactDigests: Record<"junit.xml" | "godot.log", string>;
  testPlan: "deviludo-local-testkit-1.0.0";
  fixtureOnly: true;
  createdAt: string;
};

export type LocalRuntimeHealth = {
  status: "ok" | "degraded";
  service: "deviludo-local-runtime";
  godotBinary: string;
  godotVersion: string | null;
  storage: string;
};
