import type { PostgresQueryResult } from "../../temporal/src/postgres-inbox";

const TABLE_COLUMN = /to_regclass\('deviludo\.([a-z0-9_]+)'\)::text AS ([a-z0-9_]+)/g;

export function postgresReadinessResult<Row extends Record<string, unknown>>(
  statement: string,
  missingTable: string | null = null,
): PostgresQueryResult<Row> | null {
  if (!statement.includes("to_regclass('deviludo.")) return null;
  const fields: Record<string, unknown> = {};
  for (const match of statement.matchAll(TABLE_COLUMN)) {
    if (match[1] !== match[2]) throw new Error("Readiness fixture received an aliased table");
    fields[match[2]!] = match[1] === missingTable ? null : `deviludo.${match[1]}`;
  }
  if (Object.keys(fields).length === 0) throw new Error("Readiness fixture received no table columns");
  return { rowCount: 1, rows: [fields as Row] };
}
