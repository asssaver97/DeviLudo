export type LocalRuntimeRequest = {
  projectId: string;
  runId: string;
  specRevisionId: string;
  targetMatrix: readonly ("linux" | "windows" | "macos")[];
};

export type LocalMainGateRequest = LocalRuntimeRequest & {
  candidateEvidenceId: string;
  candidateBundleDigest: string;
  candidateSha: string;
  sourceDigest: string;
};

export type LocalSteamReinstallRequest = LocalRuntimeRequest & {
  mainEvidenceId: string;
  mainBundleDigest: string;
  mainSha: string;
  mainSourceDigest: string;
  mainArtifactSha256: string;
  mfaApprovalId: string;
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

export type LocalMainGateEvidence = {
  schemaVersion: 1;
  phase: "MAIN_SHA_GATE";
  evidenceId: string;
  projectId: string;
  runId: string;
  specRevisionId: string;
  targetMatrix: readonly ("linux" | "windows" | "macos")[];
  platform: "macos";
  status: "TESTS_PASSED" | "WAITING_DEPENDENCY" | "FAILED";
  releaseGate: "WAITING_EXPORT_TEMPLATES" | "MAIN_VALIDATION_PASSED" | "TESTS_FAILED";
  candidateEvidenceId: string;
  candidateBundleDigest: string;
  candidateSha: string;
  sourceDigest: string;
  mainSha: string;
  mainSourceDigest: string;
  mergeReceipt: {
    scmProxy: "local-git-proxy-v1";
    branch: "main";
    candidateCommitSha: string;
    mainCommitSha: string;
    sourceDigest: string;
    mergedAt: string;
  };
  bundleDigest: string;
  godotVersion: string;
  checks: LocalRuntimeCheck[];
  artifacts: Array<"manifest.json" | "junit.xml" | "godot.log">;
  artifactDigests: Record<"junit.xml" | "godot.log", string>;
  buildArtifact: {
    fileName: "DeviLudoMain.zip";
    platform: "macos";
    contentType: "application/zip";
    sha256: string;
    sizeBytes: number;
  } | null;
  testPlan: "deviludo-local-testkit-1.0.0";
  fixtureOnly: true;
  createdAt: string;
};

export type LocalSteamReinstallEvidence = {
  schemaVersion: 1;
  phase: "LOCAL_STEAM_REINSTALL";
  localOnly: true;
  evidenceId: string;
  bundleDigest: string;
  projectId: string;
  runId: string;
  specRevisionId: string;
  targetMatrix: readonly ["macos"];
  platform: "macos";
  status: "TESTS_PASSED" | "FAILED";
  releaseGate: "LOCAL_STEAM_REINSTALL_PASSED" | "TESTS_FAILED";
  branch: "local-password-beta";
  buildId: string;
  mainEvidenceId: string;
  mainBundleDigest: string;
  mainSha: string;
  mainSourceDigest: string;
  mainArtifactSha256: string;
  mfaApprovalId: string;
  checks: Array<{
    name: "beta-package-integrity" | "clean-reinstall-boot";
    status: "PASSED" | "FAILED";
    durationMs: number;
    detail: string;
  }>;
  artifacts: Array<"manifest.json" | "reinstall.log">;
  artifactDigests: Record<"reinstall.log", string>;
  betaArtifact: {
    fileName: "DeviLudoLocalBeta.zip";
    platform: "macos";
    contentType: "application/zip";
    sha256: string;
    sizeBytes: number;
  } | null;
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
