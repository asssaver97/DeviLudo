BEGIN;

ALTER TABLE deviludo.tenant_entitlement_projections DROP CONSTRAINT tenant_entitlement_projections_plan_code_check;
ALTER TABLE deviludo.tenant_entitlement_projections DROP CONSTRAINT tenant_entitlement_projections_subscription_status_check;
UPDATE deviludo.tenant_entitlement_projections SET plan_code=CASE plan_code WHEN 'FREE' THEN 'TRIAL' WHEN 'BUSINESS' THEN 'PRO' WHEN 'ENTERPRISE' THEN 'PRO_PLUS' ELSE plan_code END;
UPDATE deviludo.tenant_entitlement_projections SET subscription_status='TRIAL' WHERE subscription_status='FREE';
ALTER TABLE deviludo.tenant_entitlement_projections ADD CONSTRAINT tenant_entitlement_projections_plan_code_check CHECK(plan_code IN('TRIAL','PLUS','PRO','PRO_PLUS'));
ALTER TABLE deviludo.tenant_entitlement_projections ADD CONSTRAINT tenant_entitlement_projections_subscription_status_check CHECK(subscription_status IN('TRIAL','ACTIVE','TRIALING','PAST_DUE','CANCELED'));

ALTER TABLE deviludo.tenant_entitlement_projections RENAME COLUMN available_credits_cents TO available_credits;
ALTER TABLE deviludo.tenant_entitlement_projections ADD COLUMN developer_limit integer;
ALTER TABLE deviludo.tenant_entitlement_projections ADD COLUMN viewer_limit integer;
UPDATE deviludo.tenant_entitlement_projections SET
  developer_limit=CASE plan_code WHEN 'TRIAL' THEN 1 WHEN 'PLUS' THEN 3 WHEN 'PRO' THEN 8 WHEN 'PRO_PLUS' THEN 15 END,
  viewer_limit=CASE plan_code WHEN 'TRIAL' THEN 0 ELSE 50 END;
ALTER TABLE deviludo.tenant_entitlement_projections ALTER COLUMN developer_limit SET NOT NULL;
ALTER TABLE deviludo.tenant_entitlement_projections ALTER COLUMN viewer_limit SET NOT NULL;
ALTER TABLE deviludo.tenant_entitlement_projections ADD CONSTRAINT tenant_entitlement_developer_limit_check CHECK(developer_limit BETWEEN 1 AND 15);
ALTER TABLE deviludo.tenant_entitlement_projections ADD CONSTRAINT tenant_entitlement_viewer_limit_check CHECK(viewer_limit BETWEEN 0 AND 50);

ALTER TABLE deviludo.account_usage_reservation_bindings RENAME COLUMN reserved_cents TO reserved_credits;
ALTER TABLE deviludo.account_usage_reservation_bindings RENAME COLUMN settled_cents TO settled_credits;
ALTER TABLE deviludo.account_usage_reservation_bindings ADD COLUMN rate_card_revision integer NOT NULL DEFAULT 3 CHECK(rate_card_revision>0);
ALTER TABLE deviludo.account_usage_reservation_bindings ALTER COLUMN rate_card_revision DROP DEFAULT;

COMMIT;
