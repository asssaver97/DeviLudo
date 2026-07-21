BEGIN;

-- Production upgrades need an authority stronger than "the file was mounted".
-- This ledger baselines the original initdb-only migrations by their exact
-- repository bytes. The production migrator records migration 061 itself (and
-- every successor) in the same transaction as the schema change.
CREATE TABLE IF NOT EXISTS public.deviludo_schema_migrations (
  version integer PRIMARY KEY CHECK (version BETWEEN 1 AND 999),
  filename text NOT NULL UNIQUE CHECK (
    filename ~ '^[0-9]{3}_[a-z0-9_]+\.sql$'
    AND left(filename, 3) = lpad(version::text, 3, '0')
  ),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

REVOKE ALL ON TABLE public.deviludo_schema_migrations FROM PUBLIC;

CREATE TEMP TABLE deviludo_expected_migration_baseline (
  version integer PRIMARY KEY,
  filename text NOT NULL UNIQUE,
  digest text NOT NULL
) ON COMMIT DROP;

INSERT INTO deviludo_expected_migration_baseline (version, filename, digest) VALUES
  (1, '001_core.sql', 'c62831c790dcfd96f55d38117f2e123227f843a6dde9ac826a27e7c0fc691b29'),
  (2, '002_workflow_dispatch.sql', '50a97207b26123961f3e7cc81984cf54dc674435d498e6419805f1e6007e6161'),
  (3, '003_workflow_jobs.sql', '252bc18ea700bc0a7aeb4715ed1ce2a57a47dc706b48713b02a0678f17e88549'),
  (4, '004_github_verified_identity.sql', '62cfbc5445a098e2458229ff580ca1e6dc611417bb090b105d57d441de509cb5'),
  (5, '005_steam_enrollments.sql', '5265d8f6d7fca2441c18eb4cb24c6887072523c2bc84ff1f04562787febf6ef9'),
  (6, '006_release_authorizations.sql', 'ec76b6e5c5eb7d6e75d38837d7e7f93f357dc15a00f14cb0da00421c50f527d0'),
  (7, '007_workflow_job_heartbeats.sql', '02792dd60b5aff3c7539d7de748a72ee1cd5f81b8d5b192130ad0bc57aea1c23'),
  (8, '008_workflow_control_actions.sql', '7323d5f7d7daa1abb42e59435a9e4a1285447a7a5411cad3376440d288f368ab'),
  (9, '009_workflow_inbox_tenant_key.sql', '6be3f7511efac8a25cd52f773016a6352a8e77740cb5cc216658b284a3ac5b73'),
  (10, '010_admin_idempotency.sql', '50aecd65de64da290ff87728f204a9cb620d79a537f70436fa7f3c799afa85e2'),
  (11, '011_admin_catalog.sql', 'df47a7adefad35cddbfddb05baa0033ba252d9a468e026bb0cfc827e77d81aa8'),
  (12, '012_workflow_signal_outbox.sql', 'b1798bc50e4a8b7082cbe8af1686d60373ea40bad9ffb499b73204b2f22468a6'),
  (13, '013_runner_workflow_attempts.sql', '36b51d791f42fd897362f44e5af76293c4070568d50bf8d52e4ffdde359f1b06'),
  (14, '014_runner_execution_locks.sql', 'd0504d9d91a109d20562a5427b11d8f80a0f6e23bcc158490958ff1072abebfb'),
  (15, '015_runner_ingress_transactions.sql', 'ea87452a6fae2ad55eb8fd3e577c510977d2eefacddea864447d6621d9ffac94'),
  (16, '016_approved_test_plan_bindings.sql', 'aa0d33de327ad8424e3832b2961cfedf3e17088dd6f5239f4c2d066331f3f548'),
  (17, '017_runner_toolchain_revisions.sql', '2c2c671c4d374a7979bf1515447c23b7c16ef0f1b96ca96bc806afe7dea35833'),
  (18, '018_steam_install_grants.sql', '05acb832c567b8404a10fc36df7aab04ba4c740d7d6e4eea2920f98f8a201ca6'),
  (19, '019_steam_publish_claims.sql', 'e1b21e79e67002c4b6829f30ee15599e1844e8d4aa6d0401006eb261e11099d4'),
  (20, '020_steam_workflow_operations.sql', 'a02aa0edf36c0c6b61bcd05eef7927076315342a10525e3dad6a1c64974ae423'),
  (21, '021_steam_release_execution.sql', 'ae77a1806f6564a8bfd0353ad987ee0b0e3f5caa3ba202f6d8ccf255cf77d4ed'),
  (22, '022_steam_workflow_dispatch.sql', 'fbfebe2e2d9684d643a5f84b16e74234c5d21a6bb79604f8c788ed60118f7aee'),
  (23, '023_steam_rc_issuance.sql', 'cf19fa885a7d19dafe870e233d7a9b5a594819d2f1205d6c223016c96d973d4c'),
  (24, '024_steam_release_preparation.sql', 'ce56a6d80d729e6ca3bce6f4a8caa8a64765070bcd7d1c958186c4bc81ac53a2'),
  (25, '025_steam_release_lifecycle.sql', '6e4b1a328f21141dedea5f01ee44329f22f7f4313179f46a9fcba0eeab38ae5d'),
  (26, '026_steam_clean_install_reservations.sql', 'a36f7631f8dca6a9e00aecb9a39a93eb9613dd76e0c80cf1095ced6532f6309b'),
  (27, '027_agent_supply_chain_operations.sql', 'dcfec288496617ca51ee721ac2335d18bb6ce09bf3f77425e1cc1dc227680e19'),
  (28, '028_inference_gateway.sql', 'efd0755a04796577f1c6cb845105d463d62455bd3beb735e176c4025f0e99b99'),
  (29, '029_inference_request_claims.sql', 'd8c9efa81af0775c85cb3d7dadfeb723c95aa16644399452768a0b63ea222222'),
  (30, '030_inference_reconciliation.sql', 'a910cff6f50b090daab2e18b6eec28d3f669d923fee9a6e204b2acd6e48435de'),
  (31, '031_spec_dialogue.sql', 'b6035bb2f0d4a0a4720a1e5523caa5a3cfede9d8818307bc3da5374cce47cc77'),
  (32, '032_spec_workflow_bridge.sql', 'ef7c6a6d758b2cd3b31373279f9662ac3eb837cd7fb2a79cbca0e9137dcf2eb4'),
  (33, '033_agent_configuration_resolution.sql', '2046700361bb5fb6c2b2a0a29a3ffe8b426e7f491ad2ab75dc13189ad149942d'),
  (34, '034_inference_provider_projection.sql', 'b1471fe9862c9349035edae27099ea0259d8be9cff6235cee18ea1d02df92935'),
  (35, '035_agent_execution_broker.sql', 'a133b0413daf3a94516b58214bb7b8527f6a6b205b319206bae5eb1aca49d366'),
  (36, '036_scm_candidate_publication.sql', '2a5c5ff549c5336b26a5d837e10fbf6dbb557d362dc8a53777660fcd0ca46f59'),
  (37, '037_feedback_evidence_invalidation.sql', '68bfe6439932f4a8db1bf850f423a482a27c920fde1da6b0b4329808af364955'),
  (38, '038_user_feedback_iterations.sql', 'd8e17e95ae1cd2e04987ce905be92469ae8ed3d72d214d295306586542046206'),
  (39, '039_user_candidate_acceptances.sql', '2d75692302bf37ab4da890dd2f10faaec31401beab882e49eefe99ee0426b1a1'),
  (40, '040_scm_authoritative_merges.sql', 'c01bb64e7bdf0003abda2c88e60f2d3068b50174c4b451c3e0dc933e88150c56'),
  (41, '041_delivery_state_projections.sql', '1dc7cea80920dbf57ae040a4fb63409bbd1e76a9f280e21dbea835d07e49dadb'),
  (42, '042_github_authorization_request_ledger.sql', '413a7d07838ed35021aa8a710d6c4e3541212de8b132190f174a38e9e5057149'),
  (43, '043_project_repository_onboarding.sql', '539f006f95deeff159a50cc2e255b3a9f56822ba74026b97e621af565eaf499f'),
  (44, '044_invited_platform_identity.sql', 'a2dcd639a473006a65f07c391da4ad606ebf58496f55a462c80be660ecd83390'),
  (45, '045_secret_broker.sql', '1fcf4b6a4be54853d4841ef7c88e9918deb5311af5f6a9135b245b1e42a34538'),
  (46, '046_agent_run_provider_failovers.sql', '7227e361542650f65a8b8aa646c36122a915aa67da31a5dd7760ae5263d2b7ad'),
  (47, '047_agent_run_provider_failover_audit.sql', '3594c410fff9494b583c6823a81ce579459ade1e0128251f31c07955df57cc9f'),
  (48, '048_steam_install_failure_revocations.sql', 'da0160300d21521c7068e0361c317599a8e735fed0d82e43768ffdb0647578c1'),
  (49, '049_delivery_cancellation_revocations.sql', 'f27057658571d4c344a795cdc3a58c2f11c1fc400063f60b57615ac42aa15a07'),
  (50, '050_delivery_cancellation_requests.sql', 'a27c6782c475fcb7666a34fefc916db31d57328b1e1d1c202d0ef2f3b000a298'),
  (51, '051_steam_external_approval_observations.sql', 'adb7503674f3c27e2634fc6e2c215691bbb9b3cafae35cd296692afc3fc98359'),
  (52, '052_provider_recovery_checks.sql', 'dd8a9547c7913fece85e1dbbf9f349ff6ac90600ac032eb3c13783c6859b1adf'),
  (53, '053_provider_recovery_scheduling.sql', '9dfa54213d4229b2fcef6f33e1a84aaa34ffbdcc4b964d3527cc5be9b1b9cbb5'),
  (54, '054_steam_depot_finalization_operations.sql', '4b3c25ee42bcfe9f8a912f73a991b9f223e55e8241ae983834a974dc074e3e09'),
  (55, '055_spec_model_generation_operations.sql', 'ecf6409e9ee517ef20954a8a3641c9e1a9e486ab5fdd0e5cfff34851916aa5e3'),
  (56, '056_spec_model_generation_reconciliation.sql', '2e3b0a9cc8f54622a60eee9090827e7c93ba39eecd07ec233ad05e511d68fb56'),
  (57, '057_runner_toolchain_approval_guard.sql', '8202dce66ae87adc4ee21c932c3538e880dc02d0653e3bed81e56ecf955b12fd'),
  (58, '058_runner_toolchain_publications.sql', '7d4bfd85bfe493ffec76073c90c29886989bba6e1b5e0ef63c5452e25b28ec93'),
  (59, '059_steam_project_configuration_intents.sql', '2710565776e0940f822f618a4330423c8e590f8d6f1bc8c3b119e130a0617710'),
  (60, '060_agent_run_version_attestations.sql', 'a31d37d0c3498f3a27309e10a46e7bda670046b7b071fe0c342e5ad9c96f66c1');

INSERT INTO public.deviludo_schema_migrations (version, filename, digest)
SELECT version, filename, digest
  FROM deviludo_expected_migration_baseline
ON CONFLICT (version) DO NOTHING;

DO $$
BEGIN
  IF to_regnamespace('deviludo') IS NULL
     OR to_regclass('deviludo.agent_runs') IS NULL
     OR to_regprocedure('deviludo.agent_profile_version_attestation_is_valid(jsonb)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'deviludo' AND table_name = 'agent_runs'
          AND column_name = 'agent_version_attestation_required'
     ) THEN
    RAISE EXCEPTION 'migration baseline requires schema 060' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM deviludo_expected_migration_baseline expected
      LEFT JOIN public.deviludo_schema_migrations applied USING (version)
     WHERE applied.version IS NULL
        OR applied.filename IS DISTINCT FROM expected.filename
        OR applied.digest IS DISTINCT FROM expected.digest
  ) THEN
    RAISE EXCEPTION 'migration baseline digest mismatch' USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS deviludo_schema_migrations_immutable
  ON public.deviludo_schema_migrations;
CREATE TRIGGER deviludo_schema_migrations_immutable
BEFORE UPDATE OR DELETE ON public.deviludo_schema_migrations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
