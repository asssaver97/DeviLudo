export type LocalRuntimeRequest = {
  projectId: string;
  runId: string;
  specRevisionId: string;
  targetMatrix: readonly ("linux" | "windows" | "macos")[];
};

export type LocalRuntimeCheck = {
  name: "import" | "boot" | "core-loop" | "save-load" | "performance" | "macos-export" | "macos-export-boot";
  status: "PASSED" | "FAILED" | "WAITING_DEPENDENCY";
  durationMs: number;
  detail: string;
};

export type LocalRuntimeEvidence = {
  schemaVersion: 4;
  evidenceId: string;
  projectId: string;
  runId: string;
  specRevisionId: string;
  targetMatrix: readonly ("linux" | "windows" | "macos")[];
  platform: "macos";
  status: "TESTS_PASSED" | "WAITING_DEPENDENCY" | "FAILED";
  releaseGate: "WAITING_EXPORT_TEMPLATES" | "LOCAL_VALIDATION_PASSED" | "TESTS_FAILED";
  candidateSha: string;
  sourceDigest: string;
  bundleDigest: string;
  godotVersion: string;
  checks: LocalRuntimeCheck[];
  artifacts: Array<"manifest.json" | "junit.xml" | "godot.log">;
  artifactDigests: Record<"junit.xml" | "godot.log", string>;
  buildArtifact: {
    fileName: "DeviLudoLocal.zip";
    platform: "macos";
    contentType: "application/zip";
    sha256: string;
    sizeBytes: number;
  } | null;
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
  exportTemplatesRoot: string;
};
