import { readFile } from "node:fs/promises";

const address = new URL(process.env.DEVILUDO_VAULT_ADDR ?? "");
const adminTokenFile = process.env.DEVILUDO_VAULT_ADMIN_TOKEN_FILE ?? "";
const policyDirectory = process.env.DEVILUDO_VAULT_POLICY_DIRECTORY ?? "";
if (address.protocol !== "https:" || !adminTokenFile.startsWith("/") || !policyDirectory.startsWith("/")) throw new Error("Vault bootstrap configuration is invalid");
const token = (await readFile(adminTokenFile, "utf8")).trim();
for (const [name, file] of [["deviludo-api", "vault-api.hcl"], ["deviludo-executor", "vault-executor.hcl"], ["deviludo-pki", "vault-pki.hcl"]]) {
  const policy = await readFile(`${policyDirectory}/${file}`, "utf8");
  await vault(`/v1/sys/policies/acl/${name}`, { policy }, token);
}
await vault("/v1/pki/roles/deviludo-e2e-node", {
  allow_any_name: true, allow_uri_sans: true, allowed_uri_sans: "spiffe://deviludo/e2e-node/*",
  client_flag: true, server_flag: false, key_type: "ec", key_bits: 256, max_ttl: "24h",
}, token);
for (const [file, requiredPolicy] of [["vault-api.token", "deviludo-api"], ["vault-executor.token", "deviludo-executor"], ["vault-pki.token", "deviludo-pki"]]) {
  const serviceToken = (await readFile(`/run/secrets/${file}`, "utf8")).trim();
  const lookup = await vault("/v1/auth/token/lookup-self", null, serviceToken, "GET");
  if (!Array.isArray(lookup.data?.policies) || !lookup.data.policies.includes(requiredPolicy)) throw new Error(`Vault token is missing ${requiredPolicy}`);
}
console.log(JSON.stringify({ initialized: true, policies: ["deviludo-api", "deviludo-executor", "deviludo-pki"] }));

async function vault(path, body, bearer, method = "POST") {
  const response = await fetch(new URL(path, address), {
    method, headers: { "x-vault-token": bearer, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Vault bootstrap endpoint ${path} returned ${response.status}`);
  return response.status === 204 ? {} : await response.json();
}
