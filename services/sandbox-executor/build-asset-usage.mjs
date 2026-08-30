import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const RUNTIME_SOURCE_EXTENSIONS = /\.(?:gd|tscn|tres|godot|gdshader|shader|cs|lua|js|jsx|ts|tsx|json)$/i;
const IGNORED_DIRECTORIES = new Set([
  ".git", ".godot", ".deviludo-export", ".deviludo-e2e",
  "node_modules", "build", "coverage", "dist", "docs", "test", "tests", "tools",
]);
const IGNORED_FILES = new Set(["agent.json", "manifest.json", "package-lock.json"]);
const MAX_RUNTIME_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Generated images are build inputs, not proof that the game uses them. Keep
 * the build from silently shipping disk-only art by requiring every generated
 * asset key to appear in executable project source outside tests and tools.
 */
export async function assertBuildAssetsReferenced(projectRoot, assetKeys) {
  const missing = await missingBuildAssetReferences(projectRoot, assetKeys);
  if (missing.length === 0) return;
  const shown = missing.slice(0, 20).join(", ");
  const omitted = missing.length > 20 ? ` (+${missing.length - 20} more)` : "";
  throw new Error(`BUILD_PRODUCT: Generated assets were materialized but are not referenced by runtime source: ${shown}${omitted}`);
}

export async function missingBuildAssetReferences(projectRoot, assetKeys) {
  const normalizedRoot = resolve(projectRoot);
  const pending = new Set([...new Set(assetKeys)].sort());
  if (pending.size === 0) return Object.freeze([]);
  if ([...pending].some(key => typeof key !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(key)
    || /(^|\/)\.{1,2}(\/|$)|\/\//.test(key) || key.endsWith("/"))) {
    throw new Error("Generated asset usage check received an invalid asset key");
  }

  for (const sourcePath of await runtimeSourceFiles(normalizedRoot)) {
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.size > MAX_RUNTIME_SOURCE_BYTES) continue;
    const source = stripSourceComments(await readFile(sourcePath, "utf8"));
    for (const assetKey of pending) {
      if (containsAssetReference(source, assetKey)) pending.delete(assetKey);
    }
    if (pending.size === 0) break;
  }
  return Object.freeze([...pending]);
}

async function runtimeSourceFiles(root) {
  const found = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(resolve(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || IGNORED_FILES.has(entry.name) || !RUNTIME_SOURCE_EXTENSIONS.test(entry.name)) continue;
      const sourcePath = resolve(directory, entry.name);
      const projectRelative = relative(root, sourcePath).split(sep).join("/");
      if (!projectRelative.startsWith("../")) found.push(sourcePath);
    }
  };
  await visit(root);
  return found;
}

function containsAssetReference(source, assetKey) {
  const escaped = assetKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9._/-])res://assets/generated/${escaped}\\.(?:png|jpg|webp|mp3|ogg|wav)(?=$|[^A-Za-z0-9._/-])`).test(source);
}

function stripSourceComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(stripLineComment)
    .join("\n");
}

function stripLineComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) { escaped = false; continue; }
    if (quote && character === "\\") { escaped = true; continue; }
    if (character === "\"" || character === "'") {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (!quote && character === "#") return line.slice(0, index);
    if (!quote && character === "/" && line[index + 1] === "/") return line.slice(0, index);
  }
  return line;
}
