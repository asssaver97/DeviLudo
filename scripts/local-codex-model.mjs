const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/**
 * Resolve the host Codex account's current default from its non-secret model
 * catalogue. Local task containers intentionally receive only official login
 * data, so freezing this slug keeps an already selected account default usable
 * when the optional catalogue refresh is temporarily unavailable.
 */
export function selectCodexAccountDefaultModel(cache, cliVersion) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)
    || typeof cliVersion !== "string" || !cliVersion
    || cache.client_version !== cliVersion
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
