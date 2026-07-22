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

const RELATION = /^[a-z][a-z0-9_]{0,62}$/;

/** Proves that one production adapter's complete, canonical relation set exists. */
export async function probePostgresRelations(
  pool: ReadinessPool,
  relations: readonly string[],
  failure: () => Error,
): Promise<void> {
  const canonical = [...new Set(relations)].sort();
  if (canonical.length === 0 || canonical.some((relation) => !RELATION.test(relation))
    || JSON.stringify(canonical) !== JSON.stringify(relations)) throw failure();
  const columns = canonical.map((relation) =>
    `to_regclass('deviludo.${relation}')::text AS ${relation}`).join(",\n                ");
  const client = await pool.connect();
  try {
    const result = await client.query<Record<string, unknown>>(`SELECT ${columns}`);
    const row = result.rows[0];
    if (!row || canonical.some((relation) => row[relation] !== `deviludo.${relation}`)) throw failure();
  } finally {
    client.release();
  }
}
