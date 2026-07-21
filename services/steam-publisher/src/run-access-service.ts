import { createPublicKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import { connectDeliveryClient } from "../../temporal/src/client";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { workflowSpiffeIdFromAuthorizedTls } from "../../temporal/src/receiver-http";
import { temporalTlsConfigFromEnv } from "../../temporal/src/temporal-tls";
import { SteamEnrollmentCoordinator } from "./enrollment";
import { registerSteamEnrollmentBrokerRoutes } from "./enrollment-http";
import { PostgresSteamEnrollmentStore } from "./enrollment-postgres";
import { PostgresReleaseSnapshotResolver } from "./postgres-release-lifecycle";
import { SteamProjectConfigurationCoordinator } from "./project-configuration";
import { registerSteamProjectConfigurationRoutes } from "./project-configuration-http";
import { PostgresSteamProjectConfigurationStore } from "./project-configuration-postgres";
import { ReleaseAuthorizationCoordinator } from "./release-authorization";
import { registerReleaseAuthorizationBrokerRoutes } from "./release-authorization-http";
import { PostgresReleaseAuthorizationStore } from "./release-authorization-postgres";
import {
  FixedReleaseMfaChallengeIssuer,
  MtlsReleaseMfaVerifier,
  MtlsSteamConfigVault,
  MtlsSteamInteractiveLoginConnector,
  MtlsSteamPublishAuthorizationSigner,
  PostgresSteamPublishAuthorizationArchive,
  TemporalReleaseMfaWorkflowSignal,
} from "./steam-access-dependencies";
import { SteamAccessUiSessionVerifier, type SteamAccessUiAction, type SteamAccessUiResourceKind } from "./steam-access-ui-session";

const MAX_SECRET_BYTES = 1024 * 1024;

/** Parses all production identities without opening a database or network connection. */
export async function steamAccessServiceConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [serverKey, serverCertificate, clientCa, dependencyKey, dependencyCertificate, dependencyCa,
    uiSessionPublicKey, publishAuthorizationPublicKey] = await Promise.all([
    secretFile(env, "DEVILUDO_STEAM_ACCESS_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_STEAM_ACCESS_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_STEAM_ACCESS_CLIENT_CA_FILE"),
    secretFile(env, "DEVILUDO_STEAM_ACCESS_DEPENDENCY_TLS_KEY_FILE"),
    secretFile(env, "DEVILUDO_STEAM_ACCESS_DEPENDENCY_TLS_CERT_FILE"),
    secretFile(env, "DEVILUDO_STEAM_ACCESS_DEPENDENCY_CA_FILE"),
    publicKeyFile(env, "DEVILUDO_STEAM_UI_SESSION_PUBLIC_KEY_FILE"),
    publicKeyFile(env, "DEVILUDO_STEAM_AUTHORIZATION_PUBLIC_KEY_FILE"),
  ]);
  const webSpiffeIds = spiffeSet(required(env, "DEVILUDO_STEAM_ACCESS_WEB_SPIFFE_IDS"));
  const uiSpiffeIds = spiffeSet(required(env, "DEVILUDO_STEAM_ACCESS_UI_SPIFFE_IDS"));
  if ([...webSpiffeIds].some((identity) => uiSpiffeIds.has(identity))) {
    throw new Error("Steam access Web and secure UI SPIFFE identities must be disjoint");
  }
  return Object.freeze({
    host: bindHost(env.DEVILUDO_STEAM_ACCESS_HOST),
    port: integer(env.DEVILUDO_STEAM_ACCESS_PORT, 4575, 1024, 65535),
    requestTimeoutMs: integer(env.DEVILUDO_STEAM_ACCESS_REQUEST_TIMEOUT_MS, 45_000, 1_000, 120_000),
    dependencyTimeoutMs: integer(env.DEVILUDO_STEAM_ACCESS_DEPENDENCY_TIMEOUT_MS, 30_000, 1_000, 120_000),
    publicOrigin: strictPublicOrigin(required(env, "DEVILUDO_STEAM_ACCESS_PUBLIC_ORIGIN")),
    loginConnectorUrl: strictDependencyOrigin(required(env, "DEVILUDO_STEAM_LOGIN_CONNECTOR_URL")),
    configVaultUrl: strictDependencyOrigin(required(env, "DEVILUDO_STEAM_CONFIG_VAULT_URL")),
    mfaVerifierUrl: strictDependencyOrigin(required(env, "DEVILUDO_STEAM_MFA_VERIFIER_URL")),
    authorizationSignerUrl: strictDependencyOrigin(required(env, "DEVILUDO_STEAM_AUTHORIZATION_SIGNER_URL")),
    uiSessionKeyId: requiredId(env, "DEVILUDO_STEAM_UI_SESSION_KEY_ID"),
    authorizationKeyId: requiredId(env, "DEVILUDO_STEAM_AUTHORIZATION_KEY_ID"),
    serverTls: Object.freeze({ key: serverKey, certificate: serverCertificate, ca: clientCa }),
    dependencyTls: Object.freeze({ key: dependencyKey, certificate: dependencyCertificate, ca: dependencyCa }),
    uiSessionPublicKey,
    publishAuthorizationPublicKey,
    webSpiffeIds,
    uiSpiffeIds,
  });
}

/** Production composition root for the isolated Steam enrollment and release-MFA broker. */
export async function steamAccessRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = await steamAccessServiceConfigFromEnv(env);
  const { webSpiffeIds, uiSpiffeIds, publicOrigin, dependencyTls } = config;
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "steam-access" });
  let temporal: Awaited<ReturnType<typeof connectDeliveryClient>> | null = null;
  try {
    temporal = await connectDeliveryClient({
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      tls: await temporalTlsConfigFromEnv(env),
    });
    const login = new MtlsSteamInteractiveLoginConnector({
      endpoint: config.loginConnectorUrl,
      tls: dependencyTls,
      timeoutMs: config.dependencyTimeoutMs,
    });
    const vault = new MtlsSteamConfigVault({
      endpoint: config.configVaultUrl,
      tls: dependencyTls,
      timeoutMs: config.dependencyTimeoutMs,
    });
    const mfa = new MtlsReleaseMfaVerifier({
      endpoint: config.mfaVerifierUrl,
      tls: dependencyTls,
      timeoutMs: config.dependencyTimeoutMs,
    });
    const signer = new MtlsSteamPublishAuthorizationSigner({
      endpoint: config.authorizationSignerUrl,
      keyId: config.authorizationKeyId,
      publicKey: config.publishAuthorizationPublicKey,
      tls: dependencyTls,
      timeoutMs: config.dependencyTimeoutMs,
    });
    const enrollmentStore = new PostgresSteamEnrollmentStore(pool);
    const enrollment = new SteamEnrollmentCoordinator({
      store: enrollmentStore,
      connector: login,
      vault,
      publicOrigin,
    });
    const projectConfigurations = new SteamProjectConfigurationCoordinator({
      store: new PostgresSteamProjectConfigurationStore(pool),
      vault,
      publicOrigin,
    });
    const releaseStore = new PostgresReleaseAuthorizationStore(pool);
    const releases = new ReleaseAuthorizationCoordinator({
      snapshots: new PostgresReleaseSnapshotResolver(pool),
      store: releaseStore,
      challenges: new FixedReleaseMfaChallengeIssuer(publicOrigin),
      verifier: mfa,
      signer,
      archive: new PostgresSteamPublishAuthorizationArchive(releaseStore),
      workflow: new TemporalReleaseMfaWorkflowSignal(temporal.client),
      publicOrigin,
    });
    const uiSessions = new SteamAccessUiSessionVerifier(
      config.uiSessionKeyId,
      config.uiSessionPublicKey,
    );
    const authorizeSpiffe = (allowed: ReadonlySet<string>, request: FastifyRequest) => {
      const identity = workflowSpiffeIdFromAuthorizedTls(request);
      if (!allowed.has(identity)) throw new Error("Steam access workload is not allowed");
      return identity;
    };
    const authorizeUi = (
      request: FastifyRequest,
      resourceKind: SteamAccessUiResourceKind,
      resourceId: string,
      action: SteamAccessUiAction,
    ) => {
      authorizeSpiffe(uiSpiffeIds, request);
      return uiSessions.verify(request, { resourceKind, resourceId, action });
    };
    const server = Fastify({
      logger: false,
      bodyLimit: 128 * 1024,
      requestTimeout: config.requestTimeoutMs,
      https: {
        key: config.serverTls.key,
        cert: config.serverTls.certificate,
        ca: config.serverTls.ca,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
    });
    registerSteamEnrollmentBrokerRoutes(server, {
      broker: enrollment,
      authorize: (request) => { authorizeSpiffe(webSpiffeIds, request); },
      interactiveBroker: enrollment,
      authorizeInteractive: (request, enrollmentId, action) => authorizeUi(
        request,
        "STEAM_ENROLLMENT",
        enrollmentId,
        action,
      ),
    });
    registerReleaseAuthorizationBrokerRoutes(server, {
      broker: releases,
      authorizeInternal: (request) => { authorizeSpiffe(webSpiffeIds, request); },
      authorizeMfaCompletion: (request, approvalId) => authorizeUi(
        request,
        "STEAM_RELEASE_APPROVAL",
        approvalId,
        "COMPLETE_RELEASE_MFA",
      ),
    });
    registerSteamProjectConfigurationRoutes(server, {
      broker: projectConfigurations,
      authorize: (request) => { authorizeSpiffe(webSpiffeIds, request); },
      interactive: projectConfigurations,
      authorizeInteractive: (request, intentId) => authorizeUi(
        request,
        "STEAM_PROJECT_CONFIGURATION",
        intentId,
        "SUBMIT_PROJECT_CONFIGURATION",
      ),
    });
    server.get("/healthz", async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      try {
        const identity = workflowSpiffeIdFromAuthorizedTls(request);
        if (!webSpiffeIds.has(identity) && !uiSpiffeIds.has(identity)) throw new Error("not allowed");
      } catch {
        return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED" } });
      }
      try {
        await Promise.all([pool.probe(), login.probe(), vault.probe(), mfa.probe(), signer.probe()]);
        return reply.send({ schemaVersion: "deviludo.steam-access-health.v1", status: "ok" });
      } catch {
        return reply.status(503).send({ schemaVersion: "deviludo.steam-access-health.v1", status: "unavailable" });
      }
    });
    return Object.freeze({
      host: config.host,
      port: config.port,
      pool,
      temporal,
      login,
      vault,
      mfa,
      signer,
      enrollment,
      projectConfigurations,
      releases,
      server,
    });
  } catch (error) {
    await temporal?.close().catch(() => undefined);
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSteamAccessService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await steamAccessRuntimeFromEnv(env);
  try {
    await Promise.all([
      runtime.pool.probe(),
      runtime.login.probe(),
      runtime.vault.probe(),
      runtime.mfa.probe(),
      runtime.signer.probe(),
    ]);
    await runtime.server.listen({ host: runtime.host, port: runtime.port });
    console.log(`[steam-access] READY ${runtime.host}:${runtime.port}`);
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await new Promise<void>((done) => shutdown.signal.addEventListener("abort", () => done(), { once: true }));
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await runtime.server.close().catch(() => undefined);
    await runtime.temporal.close().catch(() => undefined);
    await runtime.pool.close();
    console.log("[steam-access] STOPPED");
  }
}

async function secretFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || path.includes("\0")) {
    throw new Error(`${name} path is invalid`);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) {
      throw new Error(`${name} file is invalid`);
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function publicKeyFile(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): Promise<KeyObject> {
  const key = createPublicKey(await secretFile(env, name));
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error(`${name} is invalid`);
  return key;
}

function strictPublicOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new Error("Steam access public origin is invalid");
  return url.href;
}

function strictDependencyOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) throw new Error("Steam access dependency origin is invalid");
  return url.href;
}

function spiffeSet(value: string): ReadonlySet<string> {
  const values = value.split(",").map((item) => item.trim());
  if (!values.length || values.length > 32 || values.some((item) => !item)
    || new Set(values).size !== values.length || JSON.stringify([...values].sort()) !== JSON.stringify(values)) {
    throw new Error("Steam access SPIFFE allow-list is invalid");
  }
  for (const item of values) {
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password
      || url.search || url.hash || !url.pathname || url.pathname === "/"
      || url.toString() !== item) throw new Error("Steam access SPIFFE identity is invalid");
  }
  return new Set(values);
}

function bindHost(value: string | undefined): string {
  const result = value ?? "0.0.0.0";
  if (result !== "0.0.0.0" && result !== "::") throw new Error("Steam access bind host is invalid");
  return result;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum || String(result) !== value) {
    throw new Error("Steam access numeric configuration is invalid");
  }
  return result;
}

function requiredId(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSteamAccessService();
}
