import { randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { SteamEnrollmentPrincipal } from "./enrollment-contracts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_SESSION_SECONDS = 5 * 60;

export type SteamAccessUiAction =
  | "SUBMIT_CREDENTIALS"
  | "SUBMIT_GUARD_CODE"
  | "COMPLETE_RELEASE_MFA";

export class SteamAccessUiSessionSigner {
  constructor(
    private readonly keyId: string,
    private readonly privateKey: KeyObject,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!ID.test(keyId) || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") invalid();
  }

  issue(input: Readonly<{
    tenantId: string;
    userId: string;
    sessionBinding: string;
    resourceKind: "STEAM_ENROLLMENT" | "STEAM_RELEASE_APPROVAL";
    resourceId: string;
    action: SteamAccessUiAction;
  }>): string {
    if (!ID.test(input.tenantId) || !ID.test(input.userId) || !ID.test(input.resourceId)
      || (input.resourceKind !== "STEAM_ENROLLMENT" && input.resourceKind !== "STEAM_RELEASE_APPROVAL")
      || !["SUBMIT_CREDENTIALS", "SUBMIT_GUARD_CODE", "COMPLETE_RELEASE_MFA"].includes(input.action)
      || input.sessionBinding.length < 32 || input.sessionBinding.length > 512
      || /[\u0000-\u001f\u007f]/.test(input.sessionBinding)) invalid();
    const issued = this.now();
    if (!Number.isFinite(issued.getTime())) invalid();
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: this.keyId, typ: "DEVILUDO-STEAM-UI" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      schemaVersion: "deviludo.steam-ui-session.v1",
      tenantId: input.tenantId,
      userId: input.userId,
      sessionBinding: input.sessionBinding,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      action: input.action,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + MAX_SESSION_SECONDS * 1_000).toISOString(),
      nonce: randomUUID(),
    })).toString("base64url");
    const signingInput = `${header}.${claims}`;
    return `${signingInput}.${sign(null, Buffer.from(signingInput, "ascii"), this.privateKey).toString("base64url")}`;
  }
}

export class SteamAccessUiSessionVerifier {
  constructor(
    private readonly keyId: string,
    private readonly publicKey: KeyObject,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!ID.test(keyId) || publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") invalid();
  }

  verify(
    request: FastifyRequest,
    expected: Readonly<{
      resourceKind: "STEAM_ENROLLMENT" | "STEAM_RELEASE_APPROVAL";
      resourceId: string;
      action: SteamAccessUiAction;
    }>,
  ): SteamEnrollmentPrincipal {
    const token = request.headers["x-deviludo-steam-ui-session"];
    if (typeof token !== "string" || token.length > 4_096) invalid();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !BASE64URL.test(part))) invalid();
    const header = decodeObject(parts[0]!, "header");
    exactKeys(header, ["alg", "kid", "typ"]);
    if (header.alg !== "EdDSA" || header.kid !== this.keyId || header.typ !== "DEVILUDO-STEAM-UI") invalid();
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
    let signature: Buffer;
    try { signature = Buffer.from(parts[2]!, "base64url"); }
    catch { invalid(); }
    if (signature.byteLength !== 64 || !verify(null, signed, this.publicKey, signature)) invalid();

    const claims = decodeObject(parts[1]!, "claims");
    exactKeys(claims, [
      "schemaVersion", "tenantId", "userId", "sessionBinding", "resourceKind",
      "resourceId", "action", "issuedAt", "expiresAt", "nonce",
    ]);
    if (claims.schemaVersion !== "deviludo.steam-ui-session.v1"
      || claims.resourceKind !== expected.resourceKind || claims.resourceId !== expected.resourceId
      || claims.action !== expected.action || typeof claims.tenantId !== "string" || !ID.test(claims.tenantId)
      || typeof claims.userId !== "string" || !ID.test(claims.userId)
      || typeof claims.nonce !== "string" || !ID.test(claims.nonce)
      || typeof claims.sessionBinding !== "string" || claims.sessionBinding.length < 32
      || claims.sessionBinding.length > 512 || /[\u0000-\u001f\u007f]/.test(claims.sessionBinding)) invalid();
    const now = this.now();
    const issuedAt = iso(claims.issuedAt);
    const expiresAt = iso(claims.expiresAt);
    if (!Number.isFinite(now.getTime()) || issuedAt > now.getTime() + 30_000 || expiresAt <= now.getTime()
      || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_SESSION_SECONDS * 1_000) invalid();
    return Object.freeze({
      tenantId: claims.tenantId,
      userId: claims.userId,
      sessionBinding: claims.sessionBinding,
    });
  }
}

function decodeObject(value: string, label: string): Record<string, unknown> {
  let decoded: Buffer;
  try { decoded = Buffer.from(value, "base64url"); }
  catch { throw new Error(`Steam UI ${label} is invalid`); }
  if (decoded.byteLength < 2 || decoded.byteLength > 3_072 || decoded.toString("base64url") !== value) invalid();
  try {
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
    return parsed as Record<string, unknown>;
  } catch { invalid(); }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function iso(value: unknown): number {
  if (typeof value !== "string") invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  return parsed;
}

function invalid(): never { throw new Error("Steam secure UI session is invalid"); }
