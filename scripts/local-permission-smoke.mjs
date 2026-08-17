import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const compose = ["compose", "-f", "infra/docker-compose.yml"];
const requiredServices = [
  "postgres", "core-api", "core-scheduler", "core-sandbox", "sandbox-executord",
  "provider-proxy", "steam-proxy", "minio", "vault", "web",
];

const running = (await docker([...compose, "ps", "--services", "--filter", "status=running"]))
  .trim().split("\n").filter(Boolean);
for (const service of requiredServices) {
  if (!running.includes(service)) throw new Error(`Required local service is not running: ${service}`);
}

await inService("core-api", `
  test "$(id -u)" = 1001
  test -r /run/deviludo-vault/api.token
  test ! -r /run/deviludo-vault/root.token
  test ! -r /run/deviludo-vault/executor.token
  test ! -e /var/run/docker.sock
  test ! -w /app
  test -w /var/lib/deviludo-projects
`);
await inService("core-scheduler", `
  test "$(id -u)" = 1001
  test -r /run/deviludo-vault/api.token
  test ! -r /run/deviludo-vault/root.token
  test ! -r /run/deviludo-vault/executor.token
  test ! -e /var/run/docker.sock
  test ! -w /app
  test -w /var/lib/deviludo-projects
`);
await inService("core-sandbox", `
  test "$(id -u)" = 1001
  test -S /run/deviludo-executor/executor.sock
  test -r /run/deviludo-executor/executor.sock
  test -w /run/deviludo-executor/executor.sock
  test ! -e /run/deviludo-vault
  test ! -e /var/run/docker.sock
  test ! -w /app
  test -w /var/lib/deviludo-projects
`);
await inService("web", `
  test "$(id -u)" = 1001
  test ! -e /run/deviludo-vault
  test ! -e /var/run/docker.sock
  test ! -w /app
  ! env | grep -Eq '^(DATABASE_URL|DEVILUDO_.*DATABASE|DEVILUDO_VAULT|DEVILUDO_S3|AWS_SHARED_CREDENTIALS_FILE)='
`);
await inService("sandbox-executord", `
  test "$(id -u)" = 10001
  test -r /run/service-secrets/identity.pem
  test -r /run/service-secrets/vault.token
  test -r /run/service-secrets/s3.credentials
  test ! -e /run/service-secrets/api.token
  test -r /var/run/docker.sock
  test -w /var/run/docker.sock
  test ! -w /app
  test -w /var/lib/deviludo-projects
`);

for (const service of ["core-api", "core-scheduler", "core-sandbox", "sandbox-executord", "provider-proxy", "steam-proxy", "web"]) {
  const id = (await docker([...compose, "ps", "-q", service])).trim();
  if (!id) throw new Error(`Container id is missing: ${service}`);
  const inspect = JSON.parse(await docker(["inspect", id]))[0];
  if (!inspect?.HostConfig?.ReadonlyRootfs
    || !inspect.HostConfig.CapDrop?.includes("ALL")
    || !inspect.HostConfig.SecurityOpt?.includes("no-new-privileges:true")) {
    throw new Error(`${service} is missing the expected container privilege restrictions`);
  }
  const dockerSocket = inspect.Mounts?.some(mount => mount.Destination === "/var/run/docker.sock");
  if ((service === "sandbox-executord") !== Boolean(dockerSocket)) {
    throw new Error(`${service} has an invalid Docker socket boundary`);
  }
}

const apiCapabilities = await vaultCapabilities("core-api", "/run/deviludo-vault/api.token", [
  "secret/data/deviludo/instance/agent-runtime/api-key/versions/permission-smoke",
  "secret/data/deviludo/workspaces/00000000-0000-4000-8000-000000000000/steam/build-token/versions/00000000-0000-4000-8000-000000000001",
]);
expectCapabilities(apiCapabilities[0], ["create", "read", "update"], "Core API Agent secret");
expectCapabilities(apiCapabilities[1], ["create", "read", "update"], "Core API workspace Steam secret");

const executorCapabilities = await vaultCapabilities("sandbox-executord", "/run/service-secrets/vault.token", [
  "secret/data/deviludo/instance/agent-runtime/api-key/versions/permission-smoke",
  "secret/data/deviludo/workspaces/00000000-0000-4000-8000-000000000000/steam/build-token/versions/00000000-0000-4000-8000-000000000001",
]);
expectCapabilities(executorCapabilities[0], ["read"], "executor Agent secret");
expectCapabilities(executorCapabilities[1], ["read"], "executor workspace Steam secret");

await expectModes(new URL("../.deviludo/local/", import.meta.url), 0o700);
await expectModes(new URL("../.deviludo/local/executor-ed25519.pem", import.meta.url), 0o600);
await expectModes(new URL("../.deviludo/local/e2e-macos-ed25519.pem", import.meta.url), 0o600);
await expectModes(new URL("../.deviludo/local/s3.credentials", import.meta.url), 0o600);
await expectModes(new URL("../.deviludo/local/executor-ed25519.pub", import.meta.url), 0o644);
await expectModes(new URL("../.deviludo/local/e2e-macos-ed25519.pub", import.meta.url), 0o644);

console.log(JSON.stringify({
  permissions: "verified",
  serviceRoles: 7,
  dockerSocketHolders: ["sandbox-executord"],
  vaultPolicies: ["deviludo-api", "deviludo-executor"],
  hostIdentityModes: "verified",
}));

async function inService(service, script) {
  await docker([...compose, "exec", "-T", service, "/bin/sh", "-ec", script]);
}

async function vaultCapabilities(service, tokenFile, paths) {
  const program = `
    const fs = require("node:fs");
    const token = fs.readFileSync(process.argv[1], "utf8").trim();
    const paths = JSON.parse(process.argv[2]);
    fetch("http://vault:8200/v1/sys/capabilities-self", {
      method: "POST",
      headers: { "x-vault-token": token, "content-type": "application/json" },
      body: JSON.stringify({ paths }),
    }).then(async response => {
      if (!response.ok) throw new Error("Vault capability query failed: " + response.status);
      const body = await response.json();
      process.stdout.write(JSON.stringify(paths.map(path => body.data?.[path] ?? body[path] ?? body.capabilities)));
    }).catch(error => { console.error(error.message); process.exit(1); });
  `;
  const output = await docker([...compose, "exec", "-T", service, "node", "-e", program, tokenFile, JSON.stringify(paths)]);
  const capabilities = JSON.parse(output);
  if (!Array.isArray(capabilities) || capabilities.length !== paths.length) throw new Error("Vault returned an invalid capability matrix");
  return capabilities;
}

function expectCapabilities(actual, expected, label) {
  if (!Array.isArray(actual) || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} capabilities are invalid`);
  }
}

async function expectModes(path, expected) {
  const details = await lstat(path);
  const actual = details.mode & 0o777;
  if (actual !== expected) throw new Error(`${path.pathname} has mode ${actual.toString(8)}, expected ${expected.toString(8)}`);
}

async function docker(arguments_) {
  const result = await execute("docker", arguments_, { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 2 * 60_000 });
  return result.stdout;
}
