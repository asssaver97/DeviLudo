import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const coreUrl = new URL(process.env.DEVILUDO_CORE_API_URL ?? "");
const tokenFile = process.env.DEVILUDO_ENROLLMENT_TOKEN_FILE ?? "";
const caFile = process.env.DEVILUDO_E2E_CORE_CA_FILE ?? "";
const credentialDirectory = process.env.DEVILUDO_E2E_CREDENTIAL_DIRECTORY ?? "";
const poolKind = process.env.DEVILUDO_E2E_POOL_KIND ?? "";
const operatingSystem = process.env.DEVILUDO_E2E_OPERATING_SYSTEM ?? "";
if (coreUrl.protocol !== "https:" || ![tokenFile, caFile, credentialDirectory].every(value => isAbsolute(value))
  || !["E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"].includes(poolKind)
  || !["linux", "windows", "macos"].includes(operatingSystem)) {
  throw new Error("E2E enrollment configuration is invalid");
}
await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
const tlsKey = `${credentialDirectory}/node-tls.key`;
const csrFile = `${credentialDirectory}/node.csr`;
const receiptKey = `${credentialDirectory}/receipt-ed25519.pem`;
const receiptPublic = `${credentialDirectory}/receipt-ed25519.pub`;
await generateOnce(tlsKey, ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", tlsKey]);
await generateOnce(receiptKey, ["genpkey", "-algorithm", "Ed25519", "-out", receiptKey]);
await execute("openssl", ["pkey", "-in", receiptKey, "-pubout", "-out", receiptPublic]);
await execute("openssl", ["req", "-new", "-key", tlsKey, "-subj", `/CN=deviludo-${poolKind.toLowerCase()}`, "-out", csrFile]);
const [token, csr, publicKey, ca] = await Promise.all([
  readFile(tokenFile, "utf8").then(value => value.trim()), readFile(csrFile, "utf8"),
  readFile(receiptPublic, "utf8"), readFile(caFile),
]);
const enrollment = await callJson(new URL("/v1/e2e/enroll", coreUrl), {
  token, poolKind, operatingSystem, csr, receiptPublicKey: publicKey,
}, { ca });
if (!/^[0-9a-f-]{36}$/i.test(enrollment.nodeId) || typeof enrollment.certificate !== "string"
  || !Array.isArray(enrollment.caChain)) throw new Error("Core returned an invalid enrollment");
await writeFile(`${credentialDirectory}/node.crt`, enrollment.certificate, { mode: 0o644 });
await writeFile(`${credentialDirectory}/core-ca.crt`, `${enrollment.caChain.join("\n")}\n`, { mode: 0o644 });
await writeFile(`${credentialDirectory}/node-id`, `${enrollment.nodeId}\n`, { mode: 0o600 });
await chmod(tlsKey, 0o600); await chmod(receiptKey, 0o600);
console.log(JSON.stringify({ enrolled: true, nodeId: enrollment.nodeId, notAfter: enrollment.notAfter }));

async function generateOnce(path, arguments_) {
  try { await readFile(path); } catch { await execute("openssl", arguments_); }
}

function callJson(url, body, tls) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const call = request(url, { method: "POST", ...tls, minVersion: "TLSv1.3", headers: {
      "content-type": "application/json", "content-length": String(data.length),
    } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Core enrollment returned ${response.statusCode}: ${text.slice(0, 500)}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error("Core enrollment returned invalid JSON")); }
      });
    });
    call.once("error", reject); call.end(data);
  });
}
