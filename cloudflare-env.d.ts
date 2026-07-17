/** Minimal runtime bindings used by the local vinext worker. */
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<{ results?: T[]; success: boolean; meta: Record<string, unknown> }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly Array<{ results?: T[]; success: boolean; meta: Record<string, unknown> }>>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  dump(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  get(key: string): Promise<unknown>;
  put(key: string, value: ReadableStream | ArrayBuffer | string): Promise<unknown>;
  delete(key: string): Promise<void>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    ARTIFACTS?: R2Bucket;
  };
}
