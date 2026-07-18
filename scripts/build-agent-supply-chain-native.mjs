import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const outputDirectory = resolve("dist/agent-supply-chain-native");
const outputFile = resolve(outputDirectory, "deviludo-agent-supply-chain-native.mjs");
const metadataFile = resolve(outputDirectory, "build-metadata.json");
const buildId = randomUUID();
const temporaryOutputFile = resolve(outputDirectory, `.native-${buildId}.mjs`);
const temporaryMetadataFile = resolve(outputDirectory, `.metadata-${buildId}.json`);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const result = await build({
  entryPoints: [resolve("services/agent-supply-chain/src/run-native-policy.ts")],
  outfile: temporaryOutputFile,
  bundle: true,
  platform: "node",
  target: "node22.13",
  format: "esm",
  packages: "bundle",
  banner: { js: "#!/usr/bin/node" },
  legalComments: "none",
  sourcemap: false,
  minify: false,
  metafile: true,
  logLevel: "warning",
});
await chmod(temporaryOutputFile, 0o500);
const artifact = await readFile(temporaryOutputFile);
const metadata = Object.freeze({
  schemaVersion: "deviludo.agent-supply-chain-native-build.v1",
  artifact: outputFile,
  sha256: createHash("sha256").update(artifact).digest("hex"),
  sizeBytes: artifact.byteLength,
  nodeTarget: "22.13",
  entryPoint: "services/agent-supply-chain/src/run-native-policy.ts",
  inputs: Object.keys(result.metafile.inputs).sort(),
});
await writeFile(temporaryMetadataFile, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o400 });
await rename(temporaryOutputFile, outputFile);
await rename(temporaryMetadataFile, metadataFile);
process.stdout.write(`${JSON.stringify(metadata)}\n`);
