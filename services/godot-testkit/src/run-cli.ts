import { chmod, lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../runner-control/src/canonical";
import { testKitArtifactClientFromEnv } from "../../runner-control/src/testkit-artifact-client";
import { GodotTestKitController } from "./controller";
import { parseGodotTestKitRunRequest } from "./contracts";

const MAX_REQUEST_BYTES = 1024 * 1024;

export async function runGodotTestKitCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: Readonly<{
    controller?: Pick<GodotTestKitController, "run">;
  }> = {},
): Promise<void> {
  const { requestPath, outputPath } = parseGodotTestKitArguments(argv);
  const [runRoot, outputRoot] = await Promise.all([
    realpath(dirname(requestPath)),
    realpath(dirname(outputPath)),
  ]);
  if (outputRoot !== runRoot || basename(requestPath) !== "request.json" || basename(outputPath) !== "result.json") {
    throw new Error("Godot TestKit control paths are invalid");
  }
  const request = parseGodotTestKitRunRequest(await readBoundedJson(requestPath));
  const controller = dependencies.controller ?? new GodotTestKitController({
    artifacts: await testKitArtifactClientFromEnv(env),
  });
  const result = await controller.run(request, runRoot);
  await materializeResult(outputPath, {
    schemaVersion: "deviludo.testkit-run-result.v1",
    jobDigest: request.jobDigest,
    testKitDigest: request.testKitDigest,
    godotBinaryDigest: request.godot.binaryDigest,
    evidence: result,
  });
}

export function parseGodotTestKitArguments(argv: readonly string[]): { requestPath: string; outputPath: string } {
  if (argv.length !== 5 || argv[0] !== "run" || argv[1] !== "--request-file" || argv[3] !== "--output-file") {
    throw new Error("Godot TestKit arguments are invalid");
  }
  return { requestPath: absolute(argv[2]!), outputPath: absolute(argv[4]!) };
}

async function readBoundedJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_REQUEST_BYTES) {
    throw new Error("Godot TestKit request file is invalid");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function materializeResult(path: string, value: unknown): Promise<void> {
  const encoded = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Error("Godot TestKit result is too large");
  try {
    const file = await open(path, "wx", 0o400);
    try { await file.writeFile(encoded, "utf8"); await file.sync(); }
    finally { await file.close(); }
    if (process.platform !== "win32") await chmod(path, 0o400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== encoded) throw new Error("Godot TestKit result conflicts with an existing attempt");
  }
}

function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    throw new Error("Godot TestKit path is invalid");
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runGodotTestKitCli(); }
  catch { process.stderr.write('{"service":"deviludo-godot-testkit","code":"FAILED"}\n'); process.exitCode = 1; }
}
