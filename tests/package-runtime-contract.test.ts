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
    os?: string[];
    cpu?: string[];
  }>;
};

const supportedSharpPackages = {
  "@img/sharp-darwin-arm64": { version: "sharp", os: "darwin", cpu: "arm64" },
  "@img/sharp-darwin-x64": { version: "sharp", os: "darwin", cpu: "x64" },
  "@img/sharp-libvips-darwin-arm64": { version: "libvips", os: "darwin", cpu: "arm64" },
  "@img/sharp-libvips-darwin-x64": { version: "libvips", os: "darwin", cpu: "x64" },
  "@img/sharp-libvips-linux-arm64": { version: "libvips", os: "linux", cpu: "arm64" },
  "@img/sharp-libvips-linux-x64": { version: "libvips", os: "linux", cpu: "x64" },
  "@img/sharp-libvips-linuxmusl-arm64": { version: "libvips", os: "linux", cpu: "arm64" },
  "@img/sharp-libvips-linuxmusl-x64": { version: "libvips", os: "linux", cpu: "x64" },
  "@img/sharp-linux-arm64": { version: "sharp", os: "linux", cpu: "arm64" },
  "@img/sharp-linux-x64": { version: "sharp", os: "linux", cpu: "x64" },
  "@img/sharp-linuxmusl-arm64": { version: "sharp", os: "linux", cpu: "arm64" },
  "@img/sharp-linuxmusl-x64": { version: "sharp", os: "linux", cpu: "x64" },
  "@img/sharp-win32-x64": { version: "sharp", os: "win32", cpu: "x64" },
} as const;

test("the lockfile preserves Sharp runtimes for every supported release platform", async () => {
  const [manifest, lock] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(value => JSON.parse(value) as PackageManifest),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(value => JSON.parse(value) as PackageLock),
  ]);
  const sharpVersion = manifest.dependencies?.sharp;
  const libvipsVersion = manifest.optionalDependencies?.["@img/sharp-libvips-linux-x64"];

  assert.deepEqual(
    Object.keys(manifest.optionalDependencies ?? {}).sort(),
    Object.keys(supportedSharpPackages).sort(),
  );

  for (const [name, expected] of Object.entries(supportedSharpPackages)) {
    const manifestVersion = expected.version === "sharp" ? sharpVersion : libvipsVersion;
    const lockedPackage = lock.packages?.[`node_modules/${name}`];
    assert.equal(manifest.optionalDependencies?.[name], manifestVersion, `${name} must be pinned in package.json`);
    assert.equal(lockedPackage?.version, manifestVersion, `${name} must be present in package-lock.json`);
    assert.equal(lockedPackage?.optional, true, `${name} must remain optional`);
    assert.deepEqual(lockedPackage?.os, [expected.os], `${name} must target ${expected.os}`);
    assert.deepEqual(lockedPackage?.cpu, [expected.cpu], `${name} must target ${expected.cpu}`);
  }
});
