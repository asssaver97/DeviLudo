import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

export const SESSION_COOKIE = "deviludo_session";
export const CSRF_COOKIE = "deviludo_csrf";

export type SessionSecrets = Readonly<{
  token: string;
  tokenHash: string;
  csrfToken: string;
  csrfHash: string;
}>;

export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);
  return hash(password, {
    algorithm: 2,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (!password || password.length > 1024 || !passwordHash.startsWith("$argon2id$")) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function assertPassword(password: string): void {
  const categoryCount = [
    /[0-9]/.test(password),
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[\p{P}\p{S}]/u.test(password),
  ].filter(Boolean).length;
  if (password.length < 9 || password.length > 1024 || categoryCount < 3) {
    throw Object.assign(new Error("密码至少 9 个字符，并包含数字、大写英文字母、小写英文字母、符号四类中的任意三类"), {
      statusCode: 400,
      code: "WEAK_PASSWORD",
    });
  }
}

export function newSessionSecrets(): SessionSecrets {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  return Object.freeze({ token, tokenHash: digest(token), csrfToken, csrfHash: digest(csrfToken) });
}

export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sessionCookie(token: string | null): string {
  return cookie(SESSION_COOKIE, token, true);
}

export function csrfCookie(token: string | null): string {
  return cookie(CSRF_COOKIE, token, false);
}

function cookie(name: string, value: string | null, httpOnly: boolean): string {
  const attributes = [
    `${name}=${value ?? ""}`,
    "Path=/",
    "SameSite=Lax",
    value ? "Max-Age=604800" : "Max-Age=0",
  ];
  if (httpOnly) attributes.push("HttpOnly");
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}
