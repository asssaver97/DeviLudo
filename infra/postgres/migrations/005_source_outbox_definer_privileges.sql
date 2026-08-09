-- pull_source_ready_events and acknowledge_source_ready_events execute as the
-- narrow BYPASSRLS role. Older baselines granted their callers EXECUTE but did
-- not grant the function owner access to the outbox itself.
GRANT SELECT, UPDATE ON deviludo.project_source_ready_outbox TO deviludo_claim_executor;
