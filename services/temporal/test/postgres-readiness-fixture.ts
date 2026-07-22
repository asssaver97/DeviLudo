import type {
  PostgresQueryResult,
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "../src/postgres-inbox";

const RELATION_COLUMN = /to_regclass\('deviludo\.([a-z0-9_]+)'\)::text AS ([a-z0-9_]+)/g;

export class PostgresReadinessFixture implements PostgresWorkflowPool {
  readonly statements: string[] = [];
  releases = 0;

  constructor(readonly missingRelation: string | null = null) {}

  async connect(): Promise<PostgresWorkflowClient> {
    return {
      query: async <Row extends Record<string, unknown>>(
        statement: string,
      ): Promise<PostgresQueryResult<Row>> => {
        this.statements.push(statement);
        const columns = [...statement.matchAll(RELATION_COLUMN)];
        if (!columns.length) throw new Error("Unexpected PostgreSQL readiness query");
        const row = Object.fromEntries(columns.map((match) => [
          match[2]!, match[1] === this.missingRelation ? null : `deviludo.${match[1]}`,
        ]));
        return { rowCount: 1, rows: [row as Row] };
      },
      release: () => { this.releases += 1; },
    };
  }

  observedRelations(): readonly string[] {
    return [...(this.statements[0] ?? "").matchAll(/AS ([a-z0-9_]+)/g)].map((match) => match[1]!);
  }
}
