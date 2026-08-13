-- PostgreSQL requires a newly added enum value to commit before functions and
-- data migrations can use it, so this intentionally has no explicit BEGIN.
ALTER TYPE deviludo.workflow_state
  ADD VALUE IF NOT EXISTS 'RELEASE_DECISION_PENDING' AFTER 'E2E_TESTING';
