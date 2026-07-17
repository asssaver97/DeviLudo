import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Canonical, signCanonical, verifyCanonical } from "./canonical";
import type {
  CandidateAcceptanceClaims,
  GitHubCandidateArtifactCore,
  GitHubCandidateArtifactPayload,
  SignedCandidateAcceptance,
  SignedGitHubCandidateArtifact,
} from "./github-contracts";

export function signGitHubCandidateArtifact(
  core: GitHubCandidateArtifactCore,
  privateKey: KeyObject,
  keyId: string,
): SignedGitHubCandidateArtifact {
  assertEd25519PrivateKey(privateKey);
  if (!keyId.trim()) throw new Error("Candidate attestation key ID is required");
  const payload = Object.freeze({ ...core, artifactDigest: sha256Canonical(core) });
  return Object.freeze({
    payload,
    attestation: Object.freeze({
      algorithm: "Ed25519",
      keyId,
      signature: signCanonical(privateKey, payload),
    }),
  });
}

export function verifyGitHubCandidateArtifact(
  artifact: SignedGitHubCandidateArtifact,
  keys: ReadonlyMap<string, KeyObject>,
): boolean {
  const core: Record<string, unknown> = { ...artifact.payload };
  delete core.artifactDigest;
  const publicKey = keys.get(artifact.attestation.keyId);
  return artifact.attestation.algorithm === "Ed25519"
    && Boolean(publicKey)
    && sha256Canonical(core) === artifact.payload.artifactDigest
    && verifyCanonical(publicKey as KeyObject, artifact.payload, artifact.attestation.signature);
}

export function signCandidateAcceptance(
  claims: CandidateAcceptanceClaims,
  privateKey: KeyObject,
  keyId: string,
): SignedCandidateAcceptance {
  assertEd25519PrivateKey(privateKey);
  if (!keyId.trim()) throw new Error("Acceptance signing key ID is required");
  validateAcceptanceClaims(claims);
  return Object.freeze({
    claims: Object.freeze({ ...claims }),
    signature: Object.freeze({ algorithm: "Ed25519", keyId, value: signCanonical(privateKey, claims) }),
  });
}

export function verifyCandidateAcceptance(
  acceptance: SignedCandidateAcceptance,
  keys: ReadonlyMap<string, KeyObject>,
  expected: Readonly<{
    tenantId: string;
    projectId: string;
    candidateCommitSha: string;
    sourceDigest: string;
    specRevisionId: string;
    evidenceBundleDigest: string;
  }>,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  try {
    validateAcceptanceClaims(acceptance.claims);
  } catch {
    return false;
  }
  const publicKey = keys.get(acceptance.signature.keyId);
  const claims = acceptance.claims;
  return acceptance.signature.algorithm === "Ed25519"
    && Boolean(publicKey)
    && claims.tenantId === expected.tenantId
    && claims.projectId === expected.projectId
    && claims.candidateCommitSha === expected.candidateCommitSha
    && claims.sourceDigest === expected.sourceDigest
    && claims.specRevisionId === expected.specRevisionId
    && claims.evidenceBundleDigest === expected.evidenceBundleDigest
    && claims.iat <= nowEpochSeconds + 30
    && claims.exp > nowEpochSeconds
    && verifyCanonical(publicKey as KeyObject, claims, acceptance.signature.value);
}

export function contentSha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function candidateArtifactRequestDigest(payload: GitHubCandidateArtifactPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function validateAcceptanceClaims(claims: CandidateAcceptanceClaims): void {
  if (claims.iss !== "deviludo-control-plane" || claims.aud !== "deviludo-scm-proxy") throw new Error("Acceptance issuer or audience is invalid");
  for (const value of [claims.tenantId, claims.projectId, claims.acceptedBy, claims.specRevisionId, claims.nonce]) {
    if (!value || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new Error("Acceptance binding is invalid");
  }
  for (const digest of [claims.sourceDigest, claims.evidenceBundleDigest]) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Acceptance digest is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(claims.candidateCommitSha)) throw new Error("Acceptance commit SHA is invalid");
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > 10 * 60) {
    throw new Error("Acceptance lifetime exceeds ten minutes");
  }
}

function assertEd25519PrivateKey(privateKey: KeyObject): void {
  const publicKey = createPublicKey(privateKey);
  if (privateKey.type !== "private" || publicKey.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
}
