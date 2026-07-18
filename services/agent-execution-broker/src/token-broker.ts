import { issueRunToken, type RunTokenClaims } from "../../../lib/security/credentials";
import type { LockedAgentExecution } from "./contracts";

const SECRET_REF = /^(?:vault|kms|secret):\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1024}$/;

export interface EphemeralRunTokenSecretStore {
  put(input: Readonly<{
    runId: string;
    attemptId: string;
    value: Uint8Array;
    expiresAt: string;
  }>): Promise<Readonly<{ secretRef: string }>>;
  revoke(secretRef: string): Promise<void>;
  probe(): Promise<void>;
}

export interface PreparedRunToken {
  readonly secretRef: string;
  readonly expiresAt: string;
  revoke(): Promise<void>;
}

/** Issues an internal-gateway token, deposits it in an ephemeral secret sink, then zeroes the local bytes. */
export class HmacEphemeralRunTokenBroker {
  constructor(
    private readonly signingKey: Uint8Array,
    private readonly secrets: EphemeralRunTokenSecretStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (signingKey.byteLength < 32) throw new Error("Agent run-token signing key is too short");
  }

  async prepare(lock: LockedAgentExecution, attemptId: string): Promise<PreparedRunToken> {
    const now = this.now();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const authorizationExpiry = Math.floor(Date.parse(lock.authorizationExpiresAt) / 1_000);
    if (!Number.isFinite(nowSeconds) || !Number.isFinite(authorizationExpiry)) invalid();
    const expires = Math.min(nowSeconds + 15 * 60, authorizationExpiry);
    if (expires <= nowSeconds + 30) throw new AgentRunAuthorizationUnavailableError(lock.providerRevisionId);
    const claims: RunTokenClaims = Object.freeze({
      iss: "deviludo-control-plane",
      aud: "deviludo-inference-gateway",
      tenantId: lock.tenantId,
      projectId: lock.projectId,
      runId: lock.runId,
      profileRevisionId: lock.profileRevisionId,
      credentialVersionId: lock.credentialVersionId,
      providerRevisionId: lock.providerRevisionId,
      models: lock.authorizedModels,
      budget: Object.freeze({ maxCostUsd: lock.budget.maxUsd }),
      iat: nowSeconds,
      exp: expires,
      nonce: lock.authorizationNonce,
    });
    const bytes = new TextEncoder().encode(await issueRunToken(this.signingKey, claims));
    try {
      const stored = await this.secrets.put({ runId: lock.runId, attemptId, value: bytes,
        expiresAt: new Date(expires * 1_000).toISOString() });
      if (!SECRET_REF.test(stored.secretRef) || stored.secretRef.includes("?") || stored.secretRef.includes("#")) invalid();
      let revoked = false;
      return Object.freeze({
        secretRef: stored.secretRef,
        expiresAt: new Date(expires * 1_000).toISOString(),
        revoke: async () => { if (!revoked) { revoked = true; await this.secrets.revoke(stored.secretRef); } },
      });
    } finally {
      bytes.fill(0);
    }
  }

  async probe(): Promise<void> { await this.secrets.probe(); }
}

export class AgentRunAuthorizationUnavailableError extends Error {
  constructor(readonly providerRevisionId: string) { super("Agent run authorization is unavailable"); }
}

function invalid(): never { throw new Error("Agent run-token preparation is invalid"); }
