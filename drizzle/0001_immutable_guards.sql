-- D1 demonstration guards. Lifecycle state columns remain transitionable, but
-- the content of every revision and queued run lock is immutable.
CREATE TRIGGER game_spec_content_immutable
BEFORE UPDATE OF tenant_id, project_id, revision, previous_revision_id, content,
  content_digest, test_plan_digest, target_matrix, created_by, created_at
ON game_spec_revisions
BEGIN
  SELECT RAISE(ABORT, 'game spec revision content is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER game_spec_no_delete BEFORE DELETE ON game_spec_revisions
BEGIN SELECT RAISE(ABORT, 'game spec revisions cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER provider_revision_no_update BEFORE UPDATE ON provider_revisions
BEGIN SELECT RAISE(ABORT, 'provider revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_revision_no_delete BEFORE DELETE ON provider_revisions
BEGIN SELECT RAISE(ABORT, 'provider revisions cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER profile_content_immutable
BEFORE UPDATE OF profile_id, revision, scope, scope_id, agent_kind,
  installation_id, provider_revision_id, model_roles, credential_binding_id,
  credential_version_id, permissions, budget, fallback_profile_revision_id,
  created_at
ON agent_profile_revisions
BEGIN SELECT RAISE(ABORT, 'profile revision content is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER profile_revision_no_delete BEFORE DELETE ON agent_profile_revisions
BEGIN SELECT RAISE(ABORT, 'profile revisions cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER worker_image_no_update BEFORE UPDATE ON worker_images
BEGIN SELECT RAISE(ABORT, 'worker images are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER worker_image_no_delete BEFORE DELETE ON worker_images
BEGIN SELECT RAISE(ABORT, 'worker images cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER installation_identity_immutable
BEFORE UPDATE OF registry_id, agent_version_id, worker_image_id, image_digest,
  worker_pool, created_at
ON agent_installations
BEGIN SELECT RAISE(ABORT, 'installation identity is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER credential_material_reference_immutable
BEFORE UPDATE OF binding_id, tenant_id, project_id, secret_ref, fingerprint,
  masked_value, created_at
ON credential_versions
BEGIN SELECT RAISE(ABORT, 'credential version material reference is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER credential_version_no_delete BEFORE DELETE ON credential_versions
BEGIN SELECT RAISE(ABORT, 'credential versions cannot be deleted; revoke them'); END;
--> statement-breakpoint

CREATE TRIGGER agent_run_configuration_immutable
BEFORE UPDATE OF tenant_id, project_id, iteration_id, idempotency_key,
  profile_revision_id, installation_id, image_digest, exact_agent_version,
  adapter_version, provider_revision_id, model, credential_version_id,
  configuration_lock, resolution_digest, created_at
ON agent_runs
BEGIN SELECT RAISE(ABORT, 'agent run configuration lock is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER agent_run_no_delete BEFORE DELETE ON agent_runs
BEGIN SELECT RAISE(ABORT, 'agent runs cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER runner_event_no_update BEFORE UPDATE ON runner_events
BEGIN SELECT RAISE(ABORT, 'runner events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER runner_event_no_delete BEFORE DELETE ON runner_events
BEGIN SELECT RAISE(ABORT, 'runner events are append-only'); END;
--> statement-breakpoint

CREATE TRIGGER evidence_bundle_no_update BEFORE UPDATE ON evidence_bundles
BEGIN SELECT RAISE(ABORT, 'evidence bundles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER evidence_bundle_no_delete BEFORE DELETE ON evidence_bundles
BEGIN SELECT RAISE(ABORT, 'evidence bundles cannot be deleted'); END;
--> statement-breakpoint

CREATE TRIGGER steam_release_binding_immutable
BEFORE UPDATE OF tenant_id, project_id, main_commit_sha, source_digest,
  evidence_bundle_id, target_matrix, steam_app_id, steam_session_secret_ref,
  beta_branch, mfa_approval_id, created_at
ON steam_releases
BEGIN SELECT RAISE(ABORT, 'Steam release binding is immutable'); END;
--> statement-breakpoint

CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
