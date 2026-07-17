# DeviLudo infrastructure reference

`docker-compose.yml` is a local integration environment, not a production
deployment. Set the four `DEVILUDO_*` secrets in a private `.env`, then start it
with `docker compose -f infra/docker-compose.yml up`.

Production replaces each container with an HA managed service: PostgreSQL with
PITR and separate owner/migration/application roles, a three-node Temporal
cluster, TLS Redis, versioned/locked S3 buckets, auto-unseal Vault/KMS, and an
OTel collector exporting to the operator's telemetry backend. Worker pools,
E2E runners, inference connectors, and Steam publishers live in separate network
segments and service accounts.

`postgres/001_core.sql` demonstrates forced RLS, append-only revisions/audit,
and immutable run locks. `postgres/002_workflow_dispatch.sql` adds a leased,
idempotent activity inbox plus append-only, gate-bound external approval
receipts. Application transactions must set `app.tenant_id`
from an already-authorized session; accepting it directly from a request header
would defeat RLS. Credential values never enter these tables—only Vault refs,
fingerprints, and version IDs do.
