type CacheEntry = {
  value?: unknown;
  expiresAt: number;
  promise?: Promise<unknown>;
};

const entries = new Map<string, CacheEntry>();

export function cachedValue<T>(key: string): T | undefined {
  return entries.get(key)?.value as T | undefined;
}

export async function loadCached<T>(
  key: string,
  maxAgeMs: number,
  loader: () => Promise<T>,
  options: Readonly<{ force?: boolean; now?: number }> = {},
): Promise<T> {
  const now = options.now ?? Date.now();
  const current = entries.get(key);
  if (!options.force && current?.value !== undefined && current.expiresAt > now) return current.value as T;
  if (current?.promise) return current.promise as Promise<T>;
  const promise = loader().then(value => {
    entries.set(key, { value, expiresAt: Date.now() + maxAgeMs });
    return value;
  }).catch(error => {
    const retained = entries.get(key);
    if (retained?.promise === promise) entries.set(key, { value: retained.value, expiresAt: 0 });
    throw error;
  });
  entries.set(key, { value: current?.value, expiresAt: current?.expiresAt ?? 0, promise });
  return promise;
}

export function storeCached<T>(key: string, value: T, maxAgeMs: number): T {
  entries.set(key, { value, expiresAt: Date.now() + maxAgeMs });
  return value;
}

export function expireCached(key: string): void {
  const current = entries.get(key);
  if (current) entries.set(key, { ...current, expiresAt: 0 });
}

export function removeCached(key: string): void {
  entries.delete(key);
}

export function clearClientCache(): void {
  entries.clear();
}

export const clientCacheKeys = Object.freeze({
  instance: "instance",
  health: "health",
  projects: "projects",
  project: (projectId: string) => `project:${projectId}`,
  conversations: (projectId: string) => `project:${projectId}:conversations`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
  artifacts: (projectId: string) => `project:${projectId}:artifacts`,
  agentSettings: "settings:agent",
  serverPools: "admin:server-pools",
});
