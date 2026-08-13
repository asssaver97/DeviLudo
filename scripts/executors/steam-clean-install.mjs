#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const value = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
};
const receiptPath = value("--receipt");
const appId = value("--app-id");
const buildId = value("--build-id");
const depotId = value("--depot-id");
const platform = value("--platform");
const destination = value("--destination");
const steamcmd = process.env.DEVILUDO_STEAMCMD ?? "";
const username = process.env.DEVILUDO_STEAM_INSTALL_USERNAME ?? "";
const loginToken = process.env.DEVILUDO_STEAM_INSTALL_TOKEN ?? "";

if (![receiptPath, destination, steamcmd].every(isAbsolute)
  || !/^\d{2,12}$/.test(appId) || !/^\d+$/.test(buildId) || !/^\d{2,12}$/.test(depotId)
  || !["linux", "windows", "macos"].includes(platform)
  || !username || !loginToken) throw new Error("Steam clean-install configuration is invalid");

const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
if (receipt?.published !== true || String(receipt.appId) !== appId || String(receipt.buildId) !== buildId
  || String(receipt.depots?.[platform]) !== depotId) throw new Error("Steam publish receipt does not match the install request");

await mkdir(destination, { recursive: true });
const result = await execute(steamcmd, [
  "+force_install_dir", destination,
  "+login", username, loginToken,
  "+app_update", appId, "validate",
  "+quit",
], {
  timeout: 14 * 60_000,
  maxBuffer: 16 * 1024 * 1024,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dirname(destination), LANG: "C.UTF-8" },
});

const files = await regularFiles(destination);
if (files.length < 1 || !files.some(path => path.endsWith("/.deviludo-e2e/manifest.json") || path === ".deviludo-e2e/manifest.json")) {
  throw new Error("Steam installed package is empty or missing its E2E contract");
}
const appManifestCandidates = [
  join(dirname(steamcmd), "steamapps", `appmanifest_${appId}.acf`),
  join(destination, "steamapps", `appmanifest_${appId}.acf`),
  join(dirname(destination), "steamapps", `appmanifest_${appId}.acf`),
];
let installedBuildId = null;
for (const path of appManifestCandidates) {
  const source = await readFile(path, "utf8").catch(() => "");
  const candidate = source.match(/"buildid"\s+"(\d+)"/i)?.[1];
  if (candidate) { installedBuildId = candidate; break; }
}
if (installedBuildId !== buildId) throw new Error(`Steam installed build ${installedBuildId ?? "unknown"}; expected ${buildId}`);

process.stdout.write(`${result.stdout ?? ""}\nDEVILUDO_STEAM_INSTALL_RESULT:${JSON.stringify({
  installed: true, appId, buildId, depotId, platform, destination: resolve(destination), fileCount: files.length,
})}\n`);

async function regularFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Steam package contains a symbolic link");
    if (info.isFile()) files.push(path.slice(root.length + 1).split("\\").join("/"));
  }
  return files;
}
