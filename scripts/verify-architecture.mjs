import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const { stdout } = await execute("rg", ["--files"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
const textExtensions = new Set([
  ".ts", ".tsx", ".mjs", ".js", ".json", ".sql", ".yml", ".yaml", ".md", ".d.ts",
  ".sh", ".ps1", ".cmd", ".toml", ".hcl", ".plist",
]);
const rootTextFiles = new Set([".env.example"]);
const excluded = new Set(["scripts/verify-architecture.mjs"]);
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
for (const file of stdout.trim().split("\n").filter(Boolean)) {
  if (excluded.has(file)) continue;
  if (!textExtensions.has(extname(file)) && !rootTextFiles.has(file) && !file.startsWith("Dockerfile.") && file !== "package-lock.json") continue;
  const content = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) violations.push(`${file}: ${rule.label}`);
  }
}

const serviceDirectories = [...new Set(
  stdout.trim().split("\n")
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
