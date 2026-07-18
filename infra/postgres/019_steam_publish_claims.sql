BEGIN;

ALTER TABLE deviludo.steam_publish_claims
  ADD CONSTRAINT steam_publish_claim_completion_consistent
  CHECK ((response IS NULL) = (completed_at IS NULL));

CREATE OR REPLACE FUNCTION deviludo.protect_steam_publish_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.key, NEW.tenant_id, NEW.project_id, NEW.release_id,
         NEW.request_digest, NEW.authorized_at)
     IS DISTINCT FROM
     ROW(OLD.key, OLD.tenant_id, OLD.project_id, OLD.release_id,
         OLD.request_digest, OLD.authorized_at) THEN
    RAISE EXCEPTION 'steam publish claim binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.response IS NOT NULL AND ROW(NEW.response, NEW.completed_at)
     IS DISTINCT FROM ROW(OLD.response, OLD.completed_at) THEN
    RAISE EXCEPTION 'completed steam publish claim is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.response IS NOT NULL
     AND ROW(NEW.claim_token, NEW.claim_expires_at)
       IS DISTINCT FROM ROW(OLD.claim_token, OLD.claim_expires_at) THEN
    RAISE EXCEPTION 'completed steam publish claim cannot be reclaimed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_publish_claim_binding_immutable
BEFORE UPDATE ON deviludo.steam_publish_claims
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_steam_publish_claim();

CREATE TRIGGER steam_publish_claim_no_delete
BEFORE DELETE ON deviludo.steam_publish_claims
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE INDEX steam_publish_claim_active_idx
  ON deviludo.steam_publish_claims (tenant_id, claim_expires_at)
  WHERE response IS NULL;

COMMIT;
