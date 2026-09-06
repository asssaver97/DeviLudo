import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexModelOption } from "@/lib/product/contracts";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** Read the same account catalogue mounted into the Codex runtime.
 * Expose only picker fields, never catalogue instructions or credentials. */
export function codexModelOptions(value: unknown): readonly CodexModelOption[] {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray((value as { models?: unknown }).models)) return [];
  const candidates = ((value as { models: unknown[] }).models)
    .filter((model): model is Record<string, unknown> => Boolean(model) && typeof model === "object" && !Array.isArray(model))
    .filter(model => typeof model.slug === "string" && MODEL_ID.test(model.slug)
      && model.slug !== "account-default" && model.visibility !== "hide"
      && Number.isSafeInteger(model.priority) && Number(model.priority) >= 0)
    .sort((left, right) => Number(left.priority) - Number(right.priority));
  const seen = new Set<string>();
  return candidates.flatMap(model => {
    const id = String(model.slug);
    if (seen.has(id)) return [];
    seen.add(id);
    const displayName = typeof model.display_name === "string" && model.display_name.trim()
      ? model.display_name.trim().slice(0, 200) : id;
    return [{ id, displayName }];
  });
}

export async function readCodexModelOptions(
  path = process.env.DEVILUDO_CODEX_MODELS_CACHE_FILE?.trim()
    || join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "models_cache.json"),
): Promise<readonly CodexModelOption[]> {
  try {
    const file = await open(path, "r");
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_CATALOG_BYTES) return [];
      const bytes = Buffer.alloc(metadata.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_CATALOG_BYTES) return [];
      return codexModelOptions(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
    } finally {
      await file.close();
    }
  } catch {
    // An optional picker must not prevent configuring the runtime.
    return [];
  }
}
