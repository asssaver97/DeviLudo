import { createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PostgresRunnerExecutionLockPort } from "../../artifact-preparer/src/postgres-lock-store";
import { preparedInputTenantAuthorizerFromFiles } from "../../evidence-archive/src/prepared-input-assignments";
import { FileRunnerFleetManifestLoader, SignedRunnerFleetPolicy } from "../../runner-control/src/fleet-manifest";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { createSteamCleanInstallPreparationHandler, createSteamCleanInstallPreparationHttpsServer } from "./clean-install-http";
import { SteamCleanInstallPreparationService } from "./clean-install-preparation";
import { createSteamInstallGrantHandler, createSteamInstallGrantHttpsServer } from "./install-grant-http";
import { SteamInstallGrantRedemptionService } from "./install-grant-redemption";
import { PostgresSteamCleanInstallPreparationAuthority } from "./postgres-clean-install-authority";
import { PostgresSteamCleanInstallGrantStore } from "./postgres-install-grants";

const MAX_SECRET_BYTES = 1024 * 1024;

/** Composes two isolated mTLS listeners over one tenant-RLS PostgreSQL pool. */
export async function steamCleanInstallServicesFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const host = bindHost(env.DEVILUDO_STEAM_INSTALL_SERVICES_HOST);
  const preparationPort = port(env.DEVILUDO_STEAM_INSTALL_PREPARER_PORT, 4743);
  const redemptionPort = port(env.DEVILUDO_STEAM_INSTALL_GRANTS_PORT, 4744);
  if (preparationPort === redemptionPort) throw new Error("Steam install service ports must differ");
  const [preparerKey, preparerCert, preparerCa, assignmentKey, grantKey, grantCert, grantCa, jobKeyPem, fleetKeyPem] = await Promise.all([
    secret(env, "DEVILUDO_STEAM_INSTALL_PREPARER_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_STEAM_INSTALL_PREPARER_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_STEAM_INSTALL_PREPARER_CLIENT_CA_FILE"),
    secret(env, "DEVILUDO_STEAM_INSTALL_PREPARER_ASSIGNMENT_PUBLIC_KEY_FILE"),
    secret(env, "DEVILUDO_STEAM_INSTALL_GRANTS_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_STEAM_INSTALL_GRANTS_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_STEAM_INSTALL_GRANTS_CLIENT_CA_FILE"),
    secret(env, "DEVILUDO_STEAM_INSTALL_GRANTS_RUNNER_JOB_PUBLIC_KEY_FILE"),
    secret(env, "DEVILUDO_STEAM_INSTALL_GRANTS_RUNNER_FLEET_PUBLIC_KEY_FILE"),
  ]);
  const runnerControlSpiffeId = spiffe(env, "DEVILUDO_STEAM_INSTALL_PREPARER_RUNNER_CONTROL_SPIFFE_ID");
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "steam-install-services" });
  try {
    const tenants = preparedInputTenantAuthorizerFromFiles({
      manifestPath: absolute(env, "DEVILUDO_STEAM_INSTALL_PREPARER_ASSIGNMENT_MANIFEST_FILE"),
      keyId: required(env, "DEVILUDO_STEAM_INSTALL_PREPARER_ASSIGNMENT_KEY_ID"),
      publicKeyPem: assignmentKey,
      spiffeId: runnerControlSpiffeId,
    });
    const grants = new PostgresSteamCleanInstallGrantStore(pool, {
      ttlSeconds: integer(env.DEVILUDO_STEAM_INSTALL_GRANT_TTL_SECONDS, 10_800, 300, 86_400),
    });
    const preparation = new SteamCleanInstallPreparationService({
      tenants,
      authority: new PostgresSteamCleanInstallPreparationAuthority(pool),
      grants,
      locks: new PostgresRunnerExecutionLockPort(pool),
    });
    const preparationServer = createSteamCleanInstallPreparationHttpsServer({
      tls: { key: preparerKey, cert: preparerCert, ca: preparerCa },
      handler: createSteamCleanInstallPreparationHandler({ service: preparation, allowedSpiffeIds: new Set([runnerControlSpiffeId]) }),
    });
    const jobPublicKey = createPublicKey(jobKeyPem);
    const fleetPublicKey = createPublicKey(fleetKeyPem);
    if (jobPublicKey.asymmetricKeyType !== "ed25519" || fleetPublicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Steam install verification keys must be Ed25519");
    }
    const fleet = new SignedRunnerFleetPolicy(
      new FileRunnerFleetManifestLoader(absolute(env, "DEVILUDO_STEAM_INSTALL_GRANTS_RUNNER_FLEET_MANIFEST_FILE")),
      new Map([[required(env, "DEVILUDO_STEAM_INSTALL_GRANTS_RUNNER_FLEET_KEY_ID"), fleetPublicKey]]),
    );
    const redemption = new SteamInstallGrantRedemptionService({
      jobKeyId: required(env, "DEVILUDO_STEAM_INSTALL_GRANTS_RUNNER_JOB_KEY_ID"),
      jobPublicKey,
      fleet,
      store: grants,
    });
    const redemptionServer = createSteamInstallGrantHttpsServer({
      tls: { key: grantKey, cert: grantCert, ca: grantCa },
      handler: createSteamInstallGrantHandler({ service: redemption }),
    });
    return Object.freeze({ host, preparationPort, redemptionPort, pool, preparation, redemption, preparationServer, redemptionServer });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSteamCleanInstallServices(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const runtime = await steamCleanInstallServicesFromEnv(env);
  try {
    await Promise.all([runtime.pool.probe(), runtime.preparation.probe(), runtime.redemption.probe()]);
    await Promise.all([
      listen(runtime.preparationServer, runtime.preparationPort, runtime.host),
      listen(runtime.redemptionServer, runtime.redemptionPort, runtime.host),
    ]);
    process.stdout.write(`[steam-install-services] READY ${runtime.host}:${runtime.preparationPort},${runtime.redemptionPort}\n`);
    const close = () => { runtime.preparationServer.close(); runtime.redemptionServer.close(); };
    process.once("SIGINT", close); process.once("SIGTERM", close);
    await Promise.all([closed(runtime.preparationServer), closed(runtime.redemptionServer)]);
  } finally { await runtime.pool.close(); }
}

function listen(server: ReturnType<typeof createSteamInstallGrantHttpsServer>, selectedPort: number, host: string): Promise<void> {
  return new Promise((accept, reject) => { const fail = (error: Error) => reject(error); server.once("error", fail); server.listen(selectedPort, host, () => { server.off("error", fail); accept(); }); });
}
function closed(server: ReturnType<typeof createSteamInstallGrantHttpsServer>): Promise<void> { return new Promise((accept, reject) => { server.once("close", accept); server.once("error", reject); }); }

async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const file = await open(absolute(env, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = required(env, name); if (!isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /\0/.test(value)) throw new Error(`${name} path is invalid`); return value; }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function spiffe(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = required(env, name); const url = new URL(value); if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash || url.toString() !== value) throw new Error(`${name} is invalid`); return value; }
function bindHost(value: string | undefined): string { const selected = value ?? "0.0.0.0"; if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Steam install service host is invalid"); return selected; }
function port(value: string | undefined, fallback: number): number { return integer(value, fallback, 1024, 65535); }
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number { if (value === undefined) return fallback; const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) throw new Error("Steam install service integer is invalid"); return parsed; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSteamCleanInstallServices();
