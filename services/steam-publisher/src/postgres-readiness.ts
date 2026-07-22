interface ReadinessQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
}

interface ReadinessClient {
  query<Row extends Record<string, unknown>>(text: string): Promise<ReadinessQueryResult<Row>>;
  release(): void;
}

interface ReadinessPool {
  connect(): Promise<ReadinessClient>;
}

const TABLE = /^[a-z][a-z0-9_]{0,62}$/;

/** Proves that every relation used by one Steam production adapter is installed. */
export async function probeSteamPostgresTables(
  pool: ReadinessPool,
  tables: readonly string[],
  failure: () => Error,
): Promise<void> {
  const canonical = [...new Set(tables)].sort();
  if (canonical.length === 0 || canonical.some((table) => !TABLE.test(table))
    || JSON.stringify(canonical) !== JSON.stringify(tables)) throw failure();
  const columns = canonical.map((table) =>
    `to_regclass('deviludo.${table}')::text AS ${table}`).join(",\n                ");
  const client = await pool.connect();
  try {
    const result = await client.query<Record<string, unknown>>(`SELECT ${columns}`);
    const row = result.rows[0];
    if (!row || canonical.some((table) => row[table] !== `deviludo.${table}`)) throw failure();
  } finally {
    client.release();
  }
}
