const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CLIENT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Resolve the host Codex account's current default from its non-secret model
 * catalogue. The desktop app and CLI can update their shared non-secret cache
 * independently, so a structurally valid catalogue from another current client
 * version remains usable. Freezing its top visible slug keeps isolated calls
 * from depending on an optional catalogue refresh at startup.
 */
export function selectCodexAccountDefaultModel(cache, cliVersion) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)
    || typeof cliVersion !== "string" || !CLIENT_VERSION.test(cliVersion)
    || typeof cache.client_version !== "string" || !CLIENT_VERSION.test(cache.client_version)
    || !Array.isArray(cache.models)) {
    return null;
  }
  const candidates = cache.models
    .filter(model => model && typeof model === "object" && !Array.isArray(model)
      && typeof model.slug === "string" && MODEL_NAME.test(model.slug)
      && model.slug !== "account-default"
      && model.visibility !== "hide"
      && Number.isSafeInteger(model.priority) && model.priority >= 0)
    .sort((left, right) => left.priority - right.priority);
  return candidates[0]?.slug ?? null;
}
