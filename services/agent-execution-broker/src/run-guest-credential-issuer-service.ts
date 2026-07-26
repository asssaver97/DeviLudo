import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { PostgresAgentMicrovmCredentialAuthority } from "./guest-credential-authority-postgres";
import { LockedExt4GuestCredentialImageBuilder } from "./guest-credential-image";
import { createGuestCredentialIssuerHandler, createGuestCredentialIssuerHttpsServer } from "./guest-credential-ingress";
import { AgentMicrovmCredentialIssuerService } from "./guest-credential-service";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function guestCredentialIssuerServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [serverTlsKey, serverTlsCertificate, clientCa, attestationPrivateKey,
    relayTlsKey, relayTlsCertificate, gatewayTlsKey, gatewayTlsCertificate, gatewayCa,
    ephemeralSecretTlsKey, ephemeralSecretTlsCertificate, ephemeralSecretCa] = await Promise.all([
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_SERVER_TLS_KEY_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_SERVER_TLS_CERT_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_CLIENT_CA_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_ATTESTATION_PRIVATE_KEY_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_RELAY_TLS_KEY_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_RELAY_TLS_CERT_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_GATEWAY_TLS_KEY_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_GATEWAY_TLS_CERT_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_GATEWAY_CA_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_EPHEMERAL_SECRET_TLS_KEY_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_EPHEMERAL_SECRET_TLS_CERT_FILE"),
    readSecret(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_EPHEMERAL_SECRET_CA_FILE"),
  ]);
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "agent-credential-issuer" });
  try {
    const authority = new PostgresAgentMicrovmCredentialAuthority(pool);
    const builder = new LockedExt4GuestCredentialImageBuilder({
      workRoot: absolute(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_WORK_ROOT"),
      mke2fsExecutable: absolute(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_MKE2FS_EXECUTABLE"),
      mke2fsDigest: digest(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_MKE2FS_DIGEST"),
      material: {
        attestationPrivateKey,
        relayServerKey: relayTlsKey,
        relayServerCertificate: relayTlsCertificate,
        gatewayClientKey: gatewayTlsKey,
        gatewayClientCertificate: gatewayTlsCertificate,
        gatewayCa,
        ephemeralSecretClientKey: ephemeralSecretTlsKey,
        ephemeralSecretClientCertificate: ephemeralSecretTlsCertificate,
        ephemeralSecretCa,
        relayOrigin: exactRelayOrigin(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_RELAY_ORIGIN"),
        ephemeralSecretBrokerUrl: httpsOrigin(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_EPHEMERAL_SECRET_BROKER_URL"),
      },
    });
    const attestationKeyId = safeId(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_ATTESTATION_KEY_ID");
    const workerSpiffeId = spiffe(env, "DEVILUDO_GUEST_CREDENTIAL_ISSUER_WORKER_SPIFFE_ID");
    const service = new AgentMicrovmCredentialIssuerService({ authority, builder, attestationKeyId });
    const handler = createGuestCredentialIssuerHandler({ service, allowedSpiffeIds: new Set([workerSpiffeId]) });
    const server = createGuestCredentialIssuerHttpsServer({
      tls: { key: serverTlsKey, cert: serverTlsCertificate, ca: clientCa }, handler,
      requestTimeoutMs: seconds(env.DEVILUDO_GUEST_CREDENTIAL_ISSUER_REQUEST_TIMEOUT_SECONDS, 60, 5, 120) * 1_000,
    });
    return Object.freeze({ host: host(env.DEVILUDO_GUEST_CREDENTIAL_ISSUER_HOST),
      port: port(env.DEVILUDO_GUEST_CREDENTIAL_ISSUER_PORT), pool, service, server });
  } catch (error) { await pool.close().catch(() => undefined); throw error; }
}

export async function runGuestCredentialIssuerService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await guestCredentialIssuerServiceFromEnv(env);
  try {
    await runtime.pool.probe(); await runtime.service.probe();
    await new Promise<void>((accept, reject) => { const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail); runtime.server.listen(runtime.port, runtime.host, () => {
        runtime.server.off("error", fail); accept(); }); });
    process.stderr.write(`${JSON.stringify({ service: "deviludo-agent-microvm-credential-issuer", event: "READY" })}\n`);
    const close = () => runtime.server.close(); process.once("SIGINT", close); process.once("SIGTERM", close);
    await new Promise<void>((accept, reject) => { runtime.server.once("close", accept); runtime.server.once("error", reject); });
  } finally { await runtime.pool.close(); }
}

async function readSecret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const file = await open(absolute(env, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 32
      || metadata.size > MAX_SECRET_BYTES || (metadata.mode & 0o022) !== 0) invalid(name); return await file.readFile(); }
  finally { await file.close(); }
}
function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name); if (!isAbsolute(value) || resolve(value) !== value
    || value.length > 4_096 || value.includes("\0")) invalid(name); return value;
}
function digest(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name); if (!/^[a-f0-9]{64}$/.test(value)) invalid(name); return value;
}
function safeId(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(value)) invalid(name); return value;
}
function spiffe(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name); try { const url = new URL(value); if (url.protocol !== "spiffe:" || !url.hostname
      || url.pathname === "/" || url.username || url.password || url.search || url.hash || url.toString() !== value) invalid(name); }
  catch { invalid(name); } return value;
}
function exactRelayOrigin(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name); const url = new URL(value); if (url.protocol !== "https:" || url.hostname !== "127.0.0.1"
    || url.port !== "8443" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) invalid(name); return url.toString();
}
function httpsOrigin(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name); const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password
    || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) invalid(name); url.pathname = "/"; return url.toString();
}
function host(value: string | undefined): string { const selected = value ?? "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") invalid("host"); return selected; }
function port(value: string | undefined): number { const parsed = value === undefined ? 4673 : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_535 || (value !== undefined && String(parsed) !== value)) invalid("port"); return parsed; }
function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback; const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) invalid("timeout"); return parsed;
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value;
}
function invalid(label: string): never { throw new Error(`Agent microVM credential issuer ${label} is invalid`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runGuestCredentialIssuerService();
}
