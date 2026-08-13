import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type SteamCredentialVersion = Readonly<{
  secretRef: string;
  mask: string;
  fingerprint: string;
  version: string;
}>;

export interface SteamSecretStore {
  writeBuildToken(workspaceId: string, token: string): Promise<SteamCredentialVersion>;
  readBuildToken(workspaceId: string, secretRef: string): Promise<string | null>;
}

export function createSteamSecretStore(env: NodeJS.ProcessEnv = process.env): SteamSecretStore {
  if (env.DEVILUDO_VAULT_ADDR && env.DEVILUDO_VAULT_TOKEN_FILE) return new VaultSteamSecretStore(env);
  if (env.NODE_ENV === "production") throw new Error("Steam credentials require Vault in production");
  return new LocalSteamSecretStore(env.DEVILUDO_AGENT_SECRET_ROOT ?? "/tmp/deviludo-agent-secrets");
}

export function validateSteamBuildToken(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 8 || value.length > 4096
    || /[\r\n\0]/.test(value)) throw new Error("Steam build token format is invalid");
  return value;
}

class LocalSteamSecretStore implements SteamSecretStore {
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error("Local Steam secret root must be absolute");
  }

  async writeBuildToken(workspaceId: string, token: string): Promise<SteamCredentialVersion> {
    assertWorkspaceId(workspaceId);
    const version = randomUUID();
    const directory = join(this.root, "workspaces", workspaceId, "steam", "build-token", "versions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${version}.key`);
    const temporary = join(directory, `${version}.${process.pid}.tmp`);
    await writeFile(temporary, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    return credentialVersion(workspaceId, version, token);
  }

  async readBuildToken(workspaceId: string, secretRef: string): Promise<string | null> {
    const version = secretRefVersion(workspaceId, secretRef);
    if (!version) return null;
    try {
      return await readFile(join(this.root, "workspaces", workspaceId, "steam", "build-token", "versions", `${version}.key`), "utf8");
    } catch {
      return null;
    }
  }
}

class VaultSteamSecretStore implements SteamSecretStore {
  private readonly address: URL;
  private readonly tokenFile: string;

  constructor(env: NodeJS.ProcessEnv) {
    this.address = new URL(env.DEVILUDO_VAULT_ADDR ?? "");
    if (this.address.protocol !== "https:" && !(env.NODE_ENV !== "production" && this.address.protocol === "http:")) {
      throw new Error("Vault address must use HTTPS outside local development");
    }
    this.tokenFile = env.DEVILUDO_VAULT_TOKEN_FILE ?? "";
    if (!isAbsolute(this.tokenFile)) throw new Error("Vault token must be file-mounted");
  }

  async writeBuildToken(workspaceId: string, token: string): Promise<SteamCredentialVersion> {
    assertWorkspaceId(workspaceId);
    const version = randomUUID();
    const response = await this.request(workspaceId, version, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { value: token } }),
    });
    if (!response.ok) throw new Error(`Vault returned ${response.status}`);
    return credentialVersion(workspaceId, version, token);
  }

  async readBuildToken(workspaceId: string, secretRef: string): Promise<string | null> {
    const version = secretRefVersion(workspaceId, secretRef);
    if (!version) return null;
    const response = await this.request(workspaceId, version);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Vault returned ${response.status}`);
    const body = await response.json() as { data?: { data?: { value?: unknown } } };
    return typeof body.data?.data?.value === "string" ? body.data.data.value : null;
  }

  private async request(workspaceId: string, version: string, init: RequestInit = {}): Promise<Response> {
    const token = (await readFile(this.tokenFile, "utf8")).trim();
    const headers = new Headers(init.headers);
    headers.set("x-vault-token", token);
    return fetch(new URL(
      `/v1/secret/data/deviludo/workspaces/${workspaceId}/steam/build-token/versions/${version}`,
      this.address,
    ), { ...init, headers, signal: AbortSignal.timeout(5_000) });
  }
}

function credentialVersion(workspaceId: string, version: string, token: string): SteamCredentialVersion {
  return Object.freeze({
    secretRef: `vault://workspaces/${workspaceId}/steam/build-token/versions/${version}`,
    mask: `${token.slice(0, 3)}********${token.slice(-4)}`,
    fingerprint: `sha256:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`,
    version,
  });
}

function secretRefVersion(workspaceId: string, secretRef: string): string | null {
  const prefix = `vault://workspaces/${workspaceId}/steam/build-token/versions/`;
  if (!secretRef.startsWith(prefix)) return null;
  const version = secretRef.slice(prefix.length);
  return UUID.test(version) ? version : null;
}

function assertWorkspaceId(value: string): void {
  if (!UUID.test(value)) throw new Error("Workspace id is invalid");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
