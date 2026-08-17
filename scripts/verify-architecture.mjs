import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const textExtensions = new Set([
  ".ts", ".tsx", ".mjs", ".js", ".json", ".sql", ".yml", ".yaml", ".md", ".d.ts",
  ".sh", ".ps1", ".cmd", ".toml", ".hcl", ".plist",
]);
const rootTextFiles = new Set([".env.example"]);
const excluded = new Set(["scripts/verify-architecture.mjs"]);
const ignoredDirectories = new Set([
  ".git", ".next", ".deviludo", ".cache", ".turbo", ".vinext",
  "node_modules", "coverage", "test-results", "playwright-report", "blob-report",
  "dist", "out", "outputs", "work", "bin", "obj", "app_userdata",
]);
const sourceFiles = await listSourceFiles(root);
const forbidden = [
  { label: "retired workflow sdk", pattern: new RegExp(["tempo", "ral"].join(""), "i") },
  { label: "retired cache service", pattern: new RegExp("\\b" + ["re", "dis"].join("") + "\\b", "i") },
  {
    label: "retired edge runtime",
    pattern: new RegExp(
      ["@", "cloud", "flare"].join("") + "|" + ["cloud", "flare", ":workers"].join(""),
      "i",
    ),
  },
  { label: "retired edge cli", pattern: new RegExp(["wrang", "ler"].join(""), "i") },
  { label: "retired web compiler", pattern: new RegExp(["vi", "next"].join(""), "i") },
  { label: "retired database mapper", pattern: new RegExp(["driz", "zle"].join(""), "i") },
  { label: "retired local database binding", pattern: /\bD1(?:Database)?\b/ },
  { label: "free-form agent pool field", pattern: new RegExp(["worker", "Pool"].join("")) },
  { label: "old node endpoint", pattern: new RegExp(["execution", "-nodes"].join(""), "i") },
  { label: "old job protocol", pattern: /deviludo\.job\.v[123]\b/ },
  { label: "simulated success", pattern: /development-simulator|simulated\s*:\s*true/ },
];
const violations = [];
for (const file of sourceFiles) {
  if (excluded.has(file)) continue;
  if (!textExtensions.has(extname(file)) && !rootTextFiles.has(file) && !file.startsWith("Dockerfile.") && file !== "package-lock.json") continue;
  const content = await readFile(join(root, file), "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) violations.push(`${file}: ${rule.label}`);
  }
}

const retiredHostedControlPlane = [
  { label: "hosted access mode", pattern: new RegExp(["DEVILUDO_", "ACCESS_MODE"].join("")) },
  { label: "hosted platform configuration", pattern: new RegExp(["DEVILUDO_", "PLATFORM_"].join("")) },
  { label: "hosted platform internal API", pattern: new RegExp(["/v1/internal/", "platform"].join(""), "i") },
  { label: "hosted product session", pattern: new RegExp(["Product", "Session|platform", "Session"].join("")) },
  { label: "account-bound audit field", pattern: new RegExp(["actor_", "account_id"].join(""), "i") },
  { label: "hosted repository UI", pattern: new RegExp(["platform", "-repository"].join(""), "i") },
  { label: "hosted identity tables", pattern: new RegExp(["workspace_", "(?:memberships|invitations)|github_", "oauth_flows|project_repository_", "(?:connections|github_permissions)"].join(""), "i") },
  { label: "hosted user table", pattern: new RegExp(["CREATE TABLE deviludo.", "users"].join(""), "i") },
  { label: "retired source synchronization outbox", pattern: new RegExp(["project_source_ready_", "outbox"].join(""), "i") },
  { label: "account-era administrator route", pattern: new RegExp(["/v1/", "admin/"].join(""), "i") },
];
for (const file of sourceFiles.filter(file => /^(app|components|deploy|infra|lib|openapi|services)\//.test(file))) {
  if (!textExtensions.has(extname(file))) continue;
  const content = await readFile(join(root, file), "utf8");
  for (const rule of retiredHostedControlPlane) {
    if (rule.pattern.test(content)) violations.push(`${file}: ${rule.label}`);
  }
}

const serviceDirectories = [...new Set(
  sourceFiles
    .filter(file => file.startsWith("services/"))
    .map(file => file.split("/")[1]),
)].sort();
if (JSON.stringify(serviceDirectories) !== JSON.stringify(["core", "e2e-node", "sandbox-executor"])) {
  violations.push(`services: expected core,e2e-node,sandbox-executor; found ${serviceDirectories.join(",")}`);
}
const migrations = (await readdir(new URL("../infra/postgres/", import.meta.url)))
  .filter(file => file.endsWith(".sql"))
  .sort();
if (JSON.stringify(migrations) !== JSON.stringify(["001_core.sql"])) {
  violations.push(`database: expected one fresh 001 baseline; found ${migrations.join(",")}`);
}
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
for (const dependency of [
  ["@", "tempo", "ralio/client"].join(""),
  ["@", "tempo", "ralio/worker"].join(""),
  ["drizzle", "-orm"].join(""),
  ["vin", "ext"].join(""),
  ["wrang", "ler"].join(""),
]) {
  if (dependencyNames.includes(dependency)) violations.push(`package.json: forbidden dependency ${dependency}`);
}

if (violations.length > 0) {
  throw new Error(`Architecture verification failed:\n${violations.map(item => `- ${item}`).join("\n")}`);
}
console.log(JSON.stringify({
  architecture: "verified",
  applicationServices: serviceDirectories,
  migrations,
  serverPools: 5,
}));

async function listSourceFiles(directory, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
      files.push(...await listSourceFiles(join(directory, entry.name), relativePath));
      continue;
    }
    if (entry.isFile() && (!entry.name.startsWith(".") || rootTextFiles.has(relativePath))) files.push(relativePath);
  }
  return files;
}
