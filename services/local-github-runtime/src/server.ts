import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GitHubClientSecretResolver, GitHubVerifiedInstallation } from "../../scm-proxy/src/github-auth-contracts";
import { GitHubRestUserAuthorizationVerifier } from "../../scm-proxy/src/github-auth-rest";
import {
  GitHubInstallationAuthorizationBroker,
  InMemoryGitHubAuthorizationSecretStore,
  InMemoryGitHubAuthorizationStore,
} from "../../scm-proxy/src/github-auth";
import type { GitHubAppJwtSigner } from "../../scm-proxy/src/github-contracts";
import { GitHubAppRepositoryCatalog } from "../../scm-proxy/src/github-repository-catalog";
import {
  LocalGitHubRuntimeAuthenticationError,
  LocalGitHubRuntimeRequestVerifier,
  localGitHubRuntimeKeyFromEnvironment,
} from "./request-auth";

const HOST = "127.0.0.1";
const BODY_LIMIT = 16 * 1024;
const STATE_LIMIT = 1024 * 1024;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const NUMERIC_ID = /^\d{1,20}$/;
const CLIENT_ID = /^(?:Iv1\.[A-Za-z0-9]{16,}|Ov23li[A-Za-z0-9]{10,})$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const GITHUB_CODE = /^\S{1,512}$/;

type RuntimeOptions = Readonly<{
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecretFile: string;
  privateKeyFile: string;
  redirectUri: string;
  githubUserId: number;
  stateFile: string;
  authenticationKey?: Uint8Array;
  fetch?: typeof fetch;
}>;

type LocalRuntime = Readonly<{
  broker: GitHubInstallationAuthorizationBroker;
  catalog: GitHubAppRepositoryCatalog;
  store: InMemoryGitHubAuthorizationStore;
  state: InstallationStateFile;
  principal: Readonly<{ tenantId: string; userId: string; sessionBinding: string; expectedGithubUserId: number }>;
}>;

export async function createLocalGitHubRuntimeServer(options: RuntimeOptions) {
  validateOptions(options);
  const store = new InMemoryGitHubAuthorizationStore();
  const state = new InstallationStateFile(options.stateFile, options.appSlug, options.githubUserId);
  for (const installation of await state.load()) {
    store.installations.set(`tenant-local:${installation.installationId}`, installation);
  }
  const secrets = new LocalFileClientSecretResolver(options.clientSecretFile);
  const verifier = new GitHubRestUserAuthorizationVerifier({
    clientId: options.clientId,
    clientSecretRef: "vault://local/github-app/client-secret",
    appSlug: options.appSlug,
    redirectUri: options.redirectUri,
    secrets,
    fetch: options.fetch,
  });
  const signer = await LocalFileGitHubAppSigner.create(options.privateKeyFile, options.appId);
  const runtime: LocalRuntime = Object.freeze({
    broker: new GitHubInstallationAuthorizationBroker({
      appSlug: options.appSlug,
      clientId: options.clientId,
      redirectUri: options.redirectUri,
      store,
      secrets: new InMemoryGitHubAuthorizationSecretStore(),
      verifier,
    }),
    catalog: new GitHubAppRepositoryCatalog({ appId: options.appId, signer, fetch: options.fetch }),
    store,
    state,
    principal: Object.freeze({
      tenantId: "tenant-local",
      userId: "user-local",
      sessionBinding: Buffer.from(options.authenticationKey ?? localGitHubRuntimeKeyFromEnvironment()).toString("base64url"),
      expectedGithubUserId: options.githubUserId,
    }),
  });
  const requestVerifier = new LocalGitHubRuntimeRequestVerifier(
    options.authenticationKey ?? localGitHubRuntimeKeyFromEnvironment(),
  );
  return createServer(async (request, response) => {
    secure(response);
    try { await dispatch(request, response, requestVerifier, runtime); }
    catch (error) {
      if (error instanceof LocalGitHubRuntimeAuthenticationError) {
        return json(response, 403, { error: { code: "LOCAL_GITHUB_RUNTIME_AUTH_REQUIRED", message: "Authenticated local GitHub runtime request is required" } });
      }
      if (error instanceof BodyLimitError) return json(response, 413, { error: { code: "REQUEST_TOO_LARGE", message: "Local GitHub request is too large" } });
      return json(response, 400, { error: { code: "LOCAL_GITHUB_REQUEST_REJECTED", message: "Local GitHub operation was rejected" } });
    }
  });
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  requestVerifier: LocalGitHubRuntimeRequestVerifier,
  runtime: LocalRuntime,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}`);
  if (request.method === "GET" && url.pathname === "/health" && !url.search) {
    return json(response, 200, { status: "ok", service: "deviludo-local-github-runtime", mode: "real-github-app" });
  }
  if (url.search || request.method !== "POST" || contentType(request.headers["content-type"]) !== "application/json") {
    return json(response, 404, { error: { code: "NOT_FOUND", message: "Local GitHub runtime route not found" } });
  }
  const rawBody = await readBody(request);
  requestVerifier.verify({ method: "POST", path: url.pathname, body: rawBody, headers: request.headers });
  const parsedBody = JSON.parse(rawBody) as unknown;
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) invalid();
  if (url.pathname === "/v1/github/status") {
    exactObject(parsedBody, []);
    return json(response, 200, { data: await runtime.broker.connectionStatus(runtime.principal) });
  }
  if (url.pathname === "/v1/github/begin") {
    const value = exactObject(parsedBody, ["returnPath"]);
    if (value.returnPath !== "/settings/connections") invalid();
    return json(response, 201, { data: await runtime.broker.begin(runtime.principal, value.returnPath) });
  }
  if (url.pathname === "/v1/github/setup") {
    const value = exactObject(parsedBody, ["installationId", "setupAction", "state"]);
    if (typeof value.installationId !== "string" || !NUMERIC_ID.test(value.installationId) || value.installationId === "0"
      || (value.setupAction !== "install" && value.setupAction !== "update")
      || typeof value.state !== "string" || !STATE.test(value.state)) invalid();
    return json(response, 200, { data: await runtime.broker.beginUserAuthorization({
      principal: runtime.principal,
      installationId: value.installationId,
      setupAction: value.setupAction,
      state: value.state,
    }) });
  }
  if (url.pathname === "/v1/github/complete") {
    const value = exactObject(parsedBody, ["code", "state"]);
    if (typeof value.code !== "string" || !GITHUB_CODE.test(value.code)
      || typeof value.state !== "string" || !STATE.test(value.state)) invalid();
    const result = await runtime.broker.completeUserAuthorization({
      principal: runtime.principal,
      code: value.code,
      state: value.state,
    });
    await runtime.state.save([...runtime.store.installations.values()]);
    return json(response, 200, { data: { returnPath: result.returnPath } });
  }
  if (url.pathname === "/v1/github/repositories") {
    exactObject(parsedBody, []);
    const installations = [...runtime.store.installations.values()]
      .filter((item) => item.githubUserId === runtime.principal.expectedGithubUserId)
      .sort((left, right) => left.installationId.localeCompare(right.installationId));
    const result = [];
    for (const installation of installations) {
      result.push(Object.freeze({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        repositories: await runtime.catalog.list(installation.installationId),
      }));
    }
    return json(response, 200, { data: { installations: result } });
  }
  return json(response, 404, { error: { code: "NOT_FOUND", message: "Local GitHub runtime route not found" } });
}

class LocalFileClientSecretResolver implements GitHubClientSecretResolver {
  constructor(private readonly file: string) {}
  async resolve(secretRef: string) {
    if (secretRef !== "vault://local/github-app/client-secret") invalid();
    const value = await readSecretFile(this.file, 1_024);
    let live = value;
    return Object.freeze({
      get value() { return live; },
      destroy() { live = ""; },
    });
  }
}

class LocalFileGitHubAppSigner implements GitHubAppJwtSigner {
  readonly keyId: string;
  private constructor(private readonly key: KeyObject, appId: string) { this.keyId = `local-github-app-${appId}`; }
  static async create(file: string, appId: string) {
    const pem = await readProtectedBuffer(file, 64 * 1024);
    let key: KeyObject;
    try { key = createPrivateKey(pem); }
    catch { invalid(); }
    finally { pem.fill(0); }
    if (key.type !== "private" || key.asymmetricKeyType !== "rsa") invalid();
    return new LocalFileGitHubAppSigner(key, appId);
  }
  async signRs256(signingInput: Uint8Array): Promise<Uint8Array> {
    if (!(signingInput instanceof Uint8Array) || signingInput.byteLength < 20 || signingInput.byteLength > 4_096) invalid();
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return new Uint8Array(signer.sign(this.key));
  }
}

class InstallationStateFile {
  constructor(private readonly file: string, private readonly appSlug: string, private readonly githubUserId: number) {}
  async load(): Promise<readonly GitHubVerifiedInstallation[]> {
    let raw: string;
    try { raw = await readProtectedFile(this.file, STATE_LIMIT); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const body = exactObject(JSON.parse(raw), ["installations", "schema"]);
    if (body.schema !== "deviludo.local-github-state.v1" || !Array.isArray(body.installations) || body.installations.length > 100) invalid();
    const installations = body.installations.map((value) => parseInstallation(value, this.appSlug, this.githubUserId));
    if (new Set(installations.map((item) => item.installationId)).size !== installations.length) invalid();
    return Object.freeze(installations);
  }
  async save(installations: readonly GitHubVerifiedInstallation[]): Promise<void> {
    const normalized = installations.map((value) => parseInstallation(value, this.appSlug, this.githubUserId));
    const encoded = `${JSON.stringify({ schema: "deviludo.local-github-state.v1", installations: normalized })}\n`;
    const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(encoded, "utf8"); await handle.sync(); await handle.chmod(0o600); }
    finally { await handle.close(); }
    try { await rename(temporary, this.file); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
}

function parseInstallation(value: unknown, appSlug: string, githubUserId: number): GitHubVerifiedInstallation {
  const body = exactObject(value, ["accountLogin", "accountNodeId", "appSlug", "githubUserId", "githubUserLogin", "githubUserNodeId", "installationId", "permissions", "repositorySelection", "verifiedAt"]);
  if (typeof body.installationId !== "string" || !NUMERIC_ID.test(body.installationId) || body.installationId === "0"
    || body.githubUserId !== githubUserId || body.appSlug !== appSlug
    || !["accountLogin", "accountNodeId", "githubUserLogin", "githubUserNodeId"].every((key) => typeof body[key] === "string" && (body[key] as string).length > 0 && (body[key] as string).length <= 256)
    || (body.repositorySelection !== "all" && body.repositorySelection !== "selected")
    || typeof body.verifiedAt !== "string" || !Number.isFinite(Date.parse(body.verifiedAt))) invalid();
  const permissions = exactObject(body.permissions, ["contents", "metadata", "pull_requests"]);
  if (permissions.contents !== "write" || permissions.metadata !== "read" || permissions.pull_requests !== "write") invalid();
  return Object.freeze({ ...body, permissions: Object.freeze({ ...permissions }) }) as unknown as GitHubVerifiedInstallation;
}

async function readSecretFile(file: string, maximum: number): Promise<string> {
  const value = (await readProtectedFile(file, maximum)).trim();
  if (!value || /\0/.test(value)) invalid();
  return value;
}
async function readProtectedFile(file: string, maximum: number): Promise<string> {
  const value = await readProtectedBuffer(file, maximum);
  try { return value.toString("utf8"); }
  finally { value.fill(0); }
}
async function readProtectedBuffer(file: string, maximum: number): Promise<Buffer> {
  if (!isAbsolute(file) || resolve(file) !== file || file.includes("\0")) invalid();
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) invalid();
    return await handle.readFile();
  } finally { await handle?.close(); }
}
function validateOptions(options: RuntimeOptions): void {
  if (!NUMERIC_ID.test(options.appId) || options.appId === "0" || !APP_SLUG.test(options.appSlug)
    || !CLIENT_ID.test(options.clientId) || !Number.isSafeInteger(options.githubUserId) || options.githubUserId < 1) invalid();
  const redirect = new URL(options.redirectUri);
  if (redirect.protocol !== "http:" || (redirect.hostname !== HOST && redirect.hostname !== "localhost")
    || redirect.pathname !== "/api/connections/github/callback" || redirect.username || redirect.password || redirect.search || redirect.hash) invalid();
  for (const file of [options.clientSecretFile, options.privateKeyFile, options.stateFile]) {
    if (!isAbsolute(file) || resolve(file) !== file || file.includes("\0")) invalid();
  }
}
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return body;
}
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes <= BODY_LIMIT) chunks.push(value);
    });
    request.once("end", () => bytes > BODY_LIMIT ? reject(new BodyLimitError()) : resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("aborted")));
  });
}
function contentType(value: string | string[] | undefined): string | null { return typeof value === "string" ? value.toLowerCase().split(";", 1)[0]?.trim() ?? null : null; }
function secure(response: ServerResponse): void { response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff"); response.setHeader("referrer-policy", "no-referrer"); }
function json(response: ServerResponse, status: number, body: unknown): void { const encoded = JSON.stringify(body); response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("content-length", Buffer.byteLength(encoded)); response.end(encoded); }
function invalid(): never { throw new Error("Local GitHub runtime configuration or request is invalid"); }
class BodyLimitError extends Error {}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function parsePort(raw: string): number { const value = Number(raw); if (!Number.isInteger(value) || value < 1 || value > 65_535 || String(value) !== raw) throw new Error("DEVILUDO_LOCAL_GITHUB_RUNTIME_PORT is invalid"); return value; }
function parseGithubUserId(raw: string): number { const value = Number(raw); if (!NUMERIC_ID.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error("DEVILUDO_LOCAL_GITHUB_USER_ID is invalid"); return value; }

export async function runLocalGitHubRuntime(): Promise<void> {
  if (process.env.DEVILUDO_LOCAL_TEST_MODE !== "1" || process.env.DEVILUDO_LOCAL_GITHUB_IMPORT !== "1") {
    throw new Error("Local GitHub runtime requires explicit local import mode");
  }
  const port = parsePort(process.env.DEVILUDO_LOCAL_GITHUB_RUNTIME_PORT ?? "4315");
  const server = await createLocalGitHubRuntimeServer({
    appId: requiredEnvironment("DEVILUDO_LOCAL_GITHUB_APP_ID"),
    appSlug: requiredEnvironment("DEVILUDO_LOCAL_GITHUB_APP_SLUG"),
    clientId: requiredEnvironment("DEVILUDO_LOCAL_GITHUB_CLIENT_ID"),
    clientSecretFile: requiredEnvironment("DEVILUDO_LOCAL_GITHUB_CLIENT_SECRET_FILE"),
    privateKeyFile: requiredEnvironment("DEVILUDO_LOCAL_GITHUB_PRIVATE_KEY_FILE"),
    redirectUri: requiredEnvironment("DEVILUDO_LOCAL_GITHUB_REDIRECT_URI"),
    githubUserId: parseGithubUserId(requiredEnvironment("DEVILUDO_LOCAL_GITHUB_USER_ID")),
    stateFile: requiredEnvironment("DEVILUDO_LOCAL_GITHUB_STATE_FILE"),
  });
  server.listen(port, HOST, () => console.log(`[local-github-runtime] READY http://${HOST}:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runLocalGitHubRuntime();
