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
  replace(input: Readonly<{
    runId: string;
    attemptId: string;
    secretRef: string;
    value: Uint8Array;
    expiresAt: string;
  }>): Promise<Readonly<{ secretRef: string }>>;
  revoke(secretRef: string): Promise<void>;
  probe(): Promise<void>;
}

export interface PreparedRunToken {
  readonly secretRef: string;
  /** Initial token expiry. The stable SecretRef may be renewed beyond it. */
  readonly expiresAt: string;
  renew(): Promise<Readonly<{ expiresAt: string; renewed: boolean }>>;
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
    const issued = await this.#issue(lock);
    try {
      const stored = await this.secrets.put({ runId: lock.runId, attemptId, value: issued.bytes,
        expiresAt: issued.expiresAt });
      if (!SECRET_REF.test(stored.secretRef) || stored.secretRef.includes("?") || stored.secretRef.includes("#")) invalid();
      let revoked = false;
      let currentExpiry = issued.expiresAt;
      let renewal: Promise<Readonly<{ expiresAt: string; renewed: boolean }>> | null = null;
      return Object.freeze({
        secretRef: stored.secretRef,
        expiresAt: issued.expiresAt,
        renew: async () => {
          if (revoked) throw new AgentRunAuthorizationUnavailableError(lock.providerRevisionId);
          const remaining = Date.parse(currentExpiry) - this.now().getTime();
          if (Number.isFinite(remaining) && remaining > 5 * 60_000) {
            return Object.freeze({ expiresAt: currentExpiry, renewed: false });
          }
          renewal ??= this.#replace(lock, attemptId, stored.secretRef).then((expiresAt) => {
            currentExpiry = expiresAt;
            return Object.freeze({ expiresAt, renewed: true });
          }).finally(() => { renewal = null; });
          return renewal;
        },
        revoke: async () => { if (!revoked) { revoked = true; await this.secrets.revoke(stored.secretRef); } },
      });
    } finally {
      issued.bytes.fill(0);
    }
  }

  async #replace(lock: LockedAgentExecution, attemptId: string, secretRef: string): Promise<string> {
    const issued = await this.#issue(lock);
    try {
      const stored = await this.secrets.replace({ runId: lock.runId, attemptId, secretRef,
        value: issued.bytes, expiresAt: issued.expiresAt });
      if (stored.secretRef !== secretRef) invalid();
      return issued.expiresAt;
    } finally { issued.bytes.fill(0); }
  }

  async #issue(lock: LockedAgentExecution): Promise<Readonly<{ bytes: Uint8Array; expiresAt: string }>> {
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
    return Object.freeze({ bytes: new TextEncoder().encode(await issueRunToken(this.signingKey, claims)),
      expiresAt: new Date(expires * 1_000).toISOString() });
  }

  async probe(): Promise<void> { await this.secrets.probe(); }
}

export class AgentRunAuthorizationUnavailableError extends Error {
  constructor(readonly providerRevisionId: string) { super("Agent run authorization is unavailable"); }
}

function invalid(): never { throw new Error("Agent run-token preparation is invalid"); }
