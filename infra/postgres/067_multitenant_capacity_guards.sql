BEGIN;

ALTER TABLE deviludo.e2e_attempts
  ADD COLUMN runner_workload_class text NOT NULL DEFAULT 'VISUAL'
  CHECK (runner_workload_class IN ('HEADLESS','VISUAL','GPU','AUDIO','STEAM_INSTALL'));

CREATE OR REPLACE FUNCTION deviludo.enforce_workspace_agent_concurrency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_count integer;
BEGIN
  IF NEW.state IN ('PREPARING','RUNNING') AND OLD.state NOT IN ('PREPARING','RUNNING') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent:' || NEW.tenant_id::text, 0));
    SELECT count(*) INTO active_count
      FROM deviludo.agent_execution_operations
     WHERE tenant_id=NEW.tenant_id AND run_id<>NEW.run_id AND state IN ('PREPARING','RUNNING');
    IF active_count >= 2 THEN
      RAISE EXCEPTION 'workspace Agent concurrency limit reached' USING ERRCODE='53000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_execution_workspace_fairness
BEFORE UPDATE OF state ON deviludo.agent_execution_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.enforce_workspace_agent_concurrency();

CREATE OR REPLACE FUNCTION deviludo.enforce_workspace_e2e_concurrency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_count integer;
BEGIN
  IF NEW.runner_workload_class IS DISTINCT FROM OLD.runner_workload_class THEN
    RAISE EXCEPTION 'E2E runner workload class is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.state='RUNNING' AND OLD.state<>'RUNNING' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('e2e:' || NEW.tenant_id::text, 0));
    SELECT count(*) INTO active_count
      FROM deviludo.e2e_attempts
     WHERE tenant_id=NEW.tenant_id AND id<>NEW.id AND state='RUNNING';
    IF active_count >= 1 THEN
      RAISE EXCEPTION 'workspace exclusive E2E concurrency limit reached' USING ERRCODE='53000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER e2e_attempt_workspace_fairness
BEFORE UPDATE OF state,runner_workload_class ON deviludo.e2e_attempts
FOR EACH ROW EXECUTE FUNCTION deviludo.enforce_workspace_e2e_concurrency();

CREATE OR REPLACE FUNCTION deviludo.enforce_physical_runner_slots()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requested_class text; active_count integer; non_headless_count integer;
BEGIN
  IF NEW.state IN ('LEASED','RUNNING') AND (TG_OP='INSERT' OR OLD.state NOT IN ('LEASED','RUNNING')) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('runner:' || NEW.runner_id, 0));
    SELECT runner_workload_class INTO requested_class FROM deviludo.e2e_attempts WHERE id=NEW.attempt_id;
    SELECT count(*),count(*) FILTER(WHERE a.runner_workload_class<>'HEADLESS')
      INTO active_count,non_headless_count
      FROM deviludo.e2e_platform_leases l
      JOIN deviludo.e2e_attempts a ON a.id=l.attempt_id
     WHERE l.runner_id=NEW.runner_id AND l.id<>NEW.id AND l.state IN ('LEASED','RUNNING');
    IF (requested_class='HEADLESS' AND (active_count>=2 OR non_headless_count>0))
       OR (requested_class<>'HEADLESS' AND active_count>0) THEN
      RAISE EXCEPTION 'physical Runner slot limit reached' USING ERRCODE='53000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER physical_runner_slot_guard
BEFORE INSERT OR UPDATE OF state ON deviludo.e2e_platform_leases
FOR EACH ROW EXECUTE FUNCTION deviludo.enforce_physical_runner_slots();

CREATE INDEX e2e_attempt_workspace_active_idx ON deviludo.e2e_attempts(tenant_id,state)
  WHERE state='RUNNING';
CREATE INDEX agent_execution_workspace_active_idx ON deviludo.agent_execution_operations(tenant_id,state)
  WHERE state IN ('PREPARING','RUNNING');
CREATE INDEX runner_active_slot_idx ON deviludo.e2e_platform_leases(runner_id,state)
  WHERE state IN ('LEASED','RUNNING');

COMMIT;
