import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresQueryResult, PostgresWorkflowClient } from "../../temporal/src/postgres-inbox";
import { PostgresSteamEnrollmentStore } from "../src/enrollment-postgres";
import { PostgresSteamCleanInstallPreparationAuthority } from "../src/postgres-clean-install-authority";
import { PostgresSteamCleanInstallDispatcher } from "../src/postgres-clean-install-dispatch";
import { PostgresSteamCleanInstallGrantStore } from "../src/postgres-install-grants";
import { PostgresSteamPublishOperationStore } from "../src/postgres-publish-operations";
import { PostgresSteamRcArtifactArchive, PostgresSteamRcIssuanceAuthority } from "../src/postgres-rc-issuance";
import { PostgresSteamReleaseEvidenceGate } from "../src/postgres-release-evidence";
import {
  PostgresReleaseSnapshotResolver,
  PostgresSteamPrivateBetaReleasePreparer,
  PostgresSteamReleasePreparation,
} from "../src/postgres-release-lifecycle";
import { PostgresSteamWorkflowOperationDispatch } from "../src/postgres-workflow-dispatch";
import {
  PostgresSteamBuildReceiptArchive,
  PostgresSteamDefaultBranchReceiptArchive,
  PostgresSteamWorkflowExecutionAuthority,
} from "../src/postgres-workflow-execution";
import { PostgresSteamWorkflowOperationPersistence } from "../src/postgres-workflow-operations";
import { PostgresSteamProjectConfigurationStore } from "../src/project-configuration-postgres";
import { PostgresReleaseAuthorizationStore } from "../src/release-authorization-postgres";
import { postgresReadinessResult } from "./postgres-readiness-fixture";

type ReadyAdapter = Readonly<{ probe(): Promise<void> }>;

class ReadinessPool {
  readonly statements: string[] = [];
  releases = 0;
  missingTable: string | null = null;

  async connect(): Promise<PostgresWorkflowClient> {
    return {
      query: async <Row extends Record<string, unknown>>(
        statement: string,
      ): Promise<PostgresQueryResult<Row>> => {
        this.statements.push(statement);
        const result = postgresReadinessResult<Row>(statement, this.missingTable);
        if (!result) throw new Error("Unexpected readiness query");
        return result;
      },
      release: () => { this.releases += 1; },
    };
  }
}

const cases: readonly Readonly<{
  name: string;
  tables: readonly string[];
  create(pool: ReadinessPool): ReadyAdapter;
}>[] = [
  {
    name: "clean-install authority",
    tables: [
      "agent_runs", "approved_test_plan_bindings", "e2e_attempts", "evidence_bundles",
      "immutable_revisions", "runner_toolchain_revisions", "steam_build_receipts",
      "steam_clean_install_reservations", "steam_releases",
    ],
    create: (pool) => new PostgresSteamCleanInstallPreparationAuthority(pool),
  },
  {
    name: "clean-install dispatch",
    tables: ["steam_clean_install_reservations", "steam_releases"],
    create: (pool) => new PostgresSteamCleanInstallDispatcher(pool),
  },
  {
    name: "clean-install grants",
    tables: ["steam_install_grant_redemptions", "steam_install_grants"],
    create: (pool) => new PostgresSteamCleanInstallGrantStore(pool),
  },
  {
    name: "enrollment",
    tables: ["credential_versions", "steam_build_sessions", "steam_enrollments"],
    create: (pool) => new PostgresSteamEnrollmentStore(pool),
  },
  {
    name: "project configuration",
    tables: [
      "projects", "steam_build_sessions", "steam_enrollments", "steam_project_configuration_intents",
      "steam_project_depot_configurations", "steam_project_release_configurations", "tenant_memberships", "users",
    ],
    create: (pool) => new PostgresSteamProjectConfigurationStore(pool),
  },
  {
    name: "publish claim",
    tables: ["steam_publish_claims"],
    create: (pool) => new PostgresSteamPublishOperationStore(pool),
  },
  {
    name: "RC authority",
    tables: [
      "e2e_attempts", "evidence_bundles", "steam_project_depot_configurations",
      "steam_project_release_configurations", "steam_rc_artifacts", "steam_releases",
    ],
    create: (pool) => new PostgresSteamRcIssuanceAuthority(pool),
  },
  {
    name: "RC archive",
    tables: ["steam_rc_artifacts"],
    create: (pool) => new PostgresSteamRcArtifactArchive(pool),
  },
  {
    name: "release authorization",
    tables: ["steam_release_authorizations"],
    create: (pool) => new PostgresReleaseAuthorizationStore(pool),
  },
  {
    name: "release evidence",
    tables: ["e2e_attempts", "evidence_bundles"],
    create: (pool) => new PostgresSteamReleaseEvidenceGate(pool),
  },
  {
    name: "release preparation",
    tables: [
      "e2e_attempts", "evidence_bundles", "projects", "steam_build_sessions",
      "steam_project_depot_configurations", "steam_project_release_configurations", "steam_releases",
    ],
    create: (pool) => new PostgresSteamReleasePreparation(pool),
  },
  {
    name: "release snapshot",
    tables: [
      "e2e_attempts", "evidence_bundles", "steam_releases", "tenant_memberships",
      "user_candidate_acceptances", "users", "workflow_control_actions",
    ],
    create: (pool) => new PostgresReleaseSnapshotResolver(pool),
  },
  {
    name: "private-Beta preparation",
    tables: ["evidence_bundles", "steam_release_authorizations", "steam_releases"],
    create: (pool) => new PostgresSteamPrivateBetaReleasePreparer(pool),
  },
  {
    name: "workflow dispatch",
    tables: ["steam_workflow_operations"],
    create: (pool) => new PostgresSteamWorkflowOperationDispatch(pool),
  },
  {
    name: "workflow execution authority",
    tables: [
      "e2e_attempts", "evidence_bundles", "steam_build_receipts", "steam_build_sessions",
      "steam_rc_artifacts", "steam_release_authorizations", "steam_releases",
      "workflow_external_approval_receipts",
    ],
    create: (pool) => new PostgresSteamWorkflowExecutionAuthority(pool),
  },
  {
    name: "build receipt archive",
    tables: ["steam_build_receipts", "steam_releases"],
    create: (pool) => new PostgresSteamBuildReceiptArchive(pool),
  },
  {
    name: "default-branch archive",
    tables: ["steam_default_branch_receipts", "steam_releases"],
    create: (pool) => new PostgresSteamDefaultBranchReceiptArchive(pool),
  },
  {
    name: "workflow operations",
    tables: ["steam_workflow_operations"],
    create: (pool) => new PostgresSteamWorkflowOperationPersistence(pool),
  },
];

for (const fixture of cases) {
  test(`Steam PostgreSQL ${fixture.name} readiness checks its exact relations`, async () => {
    const pool = new ReadinessPool();
    await fixture.create(pool).probe();
    assert.equal(pool.releases, 1);
    assert.equal(pool.statements.length, 1);
    const observed = [...pool.statements[0]!.matchAll(/AS ([a-z0-9_]+)/g)].map((match) => match[1]);
    assert.deepEqual(observed, fixture.tables);

    const missing = new ReadinessPool();
    missing.missingTable = fixture.tables.at(-1)!;
    await assert.rejects(fixture.create(missing).probe());
    assert.equal(missing.releases, 1);
  });
}
