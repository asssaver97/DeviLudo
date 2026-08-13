BEGIN;

-- recover_expired_jobs() is owned by the claim executor and now replays Agent
-- guidance for replacement leases. SECURITY DEFINER bypasses RLS but does not
-- bypass ordinary table privileges, so grant only the reads and updates needed
-- to reset delivered guidance.
GRANT SELECT, UPDATE ON deviludo.job_guidance_messages TO deviludo_claim_executor;

COMMIT;
