import { readFile } from "node:fs/promises";

export class E2ePkiIssuer {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async issue(nodeId: string, csr: string) {
    if (!csr.includes("BEGIN CERTIFICATE REQUEST") || csr.length > 32_768) throw new Error("E2E CSR is invalid");
    const address = this.env.DEVILUDO_VAULT_ADDR ?? "";
    const tokenFile = this.env.DEVILUDO_VAULT_PKI_TOKEN_FILE ?? "";
    if (!address.startsWith("https://") || !tokenFile.startsWith("/")) throw new Error("Vault PKI is not configured");
    const token = (await readFile(tokenFile, "utf8")).trim();
    const response = await fetch(new URL("/v1/pki/sign/deviludo-e2e-node", address), {
      method: "POST",
      headers: { "x-vault-token": token, "content-type": "application/json" },
      body: JSON.stringify({ csr, uri_sans: `spiffe://deviludo/e2e-node/${nodeId}`, ttl: "24h" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Vault PKI returned ${response.status}`);
    const body = await response.json() as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    if (typeof data.certificate !== "string" || typeof data.serial_number !== "string"
      || typeof data.expiration !== "number" || !Array.isArray(data.ca_chain)) throw new Error("Vault PKI response is invalid");
    return Object.freeze({
      certificate: data.certificate,
      caChain: Object.freeze(data.ca_chain.filter((item): item is string => typeof item === "string")),
      serialNumber: data.serial_number,
      notAfter: new Date(data.expiration * 1000).toISOString(),
      spiffeUri: `spiffe://deviludo/e2e-node/${nodeId}`,
    });
  }
}
