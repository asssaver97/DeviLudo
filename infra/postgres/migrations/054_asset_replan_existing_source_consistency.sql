BEGIN;

-- An Agent re-plan updates an asset item to `planned` before Core reconciles
-- paths found in the newly published source revision. Normalize that transition
-- atomically so an old `existing` source_path cannot violate the table CHECK.
CREATE OR REPLACE FUNCTION deviludo.normalize_asset_item_existing_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
BEGIN
  IF NEW.status <> 'existing' THEN
    NEW.source_path := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS asset_items_normalize_existing_source ON deviludo.asset_items;
CREATE TRIGGER asset_items_normalize_existing_source
BEFORE INSERT OR UPDATE OF status, source_path ON deviludo.asset_items
FOR EACH ROW EXECUTE FUNCTION deviludo.normalize_asset_item_existing_source();
REVOKE ALL ON FUNCTION deviludo.normalize_asset_item_existing_source() FROM PUBLIC;

COMMIT;
