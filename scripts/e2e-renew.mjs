import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const directory = process.env.DEVILUDO_E2E_CREDENTIAL_DIRECTORY ?? "";
const coreUrl = new URL(process.env.DEVILUDO_CORE_API_URL ?? "");
if (!isAbsolute(directory) || coreUrl.protocol !== "https:") throw new Error("E2E renewal configuration is invalid");
const [nodeId, key, cert, ca] = await Promise.all([
  readFile(`${directory}/node-id`, "utf8").then(value => value.trim()),
  readFile(`${directory}/node-tls.key`), readFile(`${directory}/node.crt`), readFile(`${directory}/core-ca.crt`),
]);
const csrFile = `${directory}/node-renew.csr`;
await execute("openssl", ["req", "-new", "-key", `${directory}/node-tls.key`, "-subj", `/CN=deviludo-e2e-${nodeId}`, "-out", csrFile]);
const csr = await readFile(csrFile, "utf8");
const data = Buffer.from(JSON.stringify({ csr }));
const renewed = await new Promise((resolve, reject) => {
  const call = request(new URL(`/v1/e2e/nodes/${nodeId}/renew`, coreUrl), {
    method: "POST", key, cert, ca, minVersion: "TLSv1.3",
    headers: { "content-type": "application/json", "content-length": String(data.length) },
  }, response => {
    const chunks = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Core renewal returned ${response.statusCode}: ${text.slice(0, 500)}`));
      try { resolve(JSON.parse(text)); } catch { reject(new Error("Core renewal returned invalid JSON")); }
    });
  });
  call.once("error", reject); call.end(data);
});
await writeFile(`${directory}/node.crt`, renewed.certificate, { mode: 0o644 });
if (Array.isArray(renewed.caChain)) await writeFile(`${directory}/core-ca.crt`, `${renewed.caChain.join("\n")}\n`, { mode: 0o644 });
console.log(JSON.stringify({ renewed: true, nodeId, notAfter: renewed.notAfter }));
