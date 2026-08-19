import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type PackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<string, {
    version?: string;
    optional?: boolean;
  }>;
};

test("the lockfile preserves Sharp's Linux x64 runtime used by Ubuntu CI", async () => {
  const [manifest, lock] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(value => JSON.parse(value) as PackageManifest),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(value => JSON.parse(value) as PackageLock),
  ]);
  const sharpVersion = manifest.dependencies?.sharp;
  const linuxRuntime = lock.packages?.["node_modules/@img/sharp-linux-x64"];
  const linuxLibvips = lock.packages?.["node_modules/@img/sharp-libvips-linux-x64"];

  assert.equal(manifest.optionalDependencies?.["@img/sharp-linux-x64"], sharpVersion);
  assert.equal(linuxRuntime?.version, sharpVersion);
  assert.equal(linuxRuntime?.optional, true);
  assert.equal(
    linuxLibvips?.version,
    manifest.optionalDependencies?.["@img/sharp-libvips-linux-x64"],
  );
  assert.equal(linuxLibvips?.optional, true);
});
