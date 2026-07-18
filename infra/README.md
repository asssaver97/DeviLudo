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
receipts. `postgres/003_workflow_jobs.sql` adds destination-specific durable
jobs with `SKIP LOCKED` leasing, exact attempt fencing and terminal-state
immutability. `postgres/004_github_verified_identity.sql` adds the verified
numeric GitHub user binding to each active installation. Migrations `005`–`008`
add Steam Guard enrollment metadata, release MFA authorization, safe job
heartbeats and durable control-plane wait actions. Migration `009` scopes the
workflow inbox primary key to `tenant_id + idempotency_key`, preventing a key
used by one tenant from blocking another tenant through an RLS-hidden row.
Migration `010` adds bounded, digest-keyed administrator mutation claims so
idempotent results survive control-plane restarts and remain atomic across
replicas. Migration `011` adds the versioned Agent administration catalog and
its separate append-only audit ledger. Migration `012` atomically completes
authoritative workflow actions and records their exact Temporal signals in a
tenant-RLS transactional outbox so an approval cannot be lost after a process
failure. Migration `013` gives workflow-created E2E attempts a tenant-scoped
idempotency binding, immutable mode/source/commit fields, terminal transition
guards and immutable evidence bundles. It also requires SCM to record the
actual merged-main source digest instead of reusing a candidate digest.
Migration `014` introduces an append-only, tenant-RLS Runner execution lock that
content-binds prepared source/Steam inputs, the exact Godot/TestKit/export
toolchain and supply-chain evidence before any physical job can be scheduled.
Workflow E2E attempts hold a same-tenant foreign key to that lock.
Migration `015` hardens physical Runner registrations and platform leases,
persists the complete Ed25519-signed job for exact retry replay, reserves an
immutable platform-evidence slot and makes Runner events append-only.
Migrations `016`–`018` bind approved test plans and fixed Runner toolchains,
then add expiring, once-per-platform Steam install grants. Migration `019`
persists fenced private-Beta upload claims. Migrations `020`–`021` add durable
Steam workflow operations, signed RC authority and append-only private-Beta and
default-branch receipts. Migration `022` turns each operation into a recoverable
tenant-RLS dispatch outbox with bounded retry scheduling. Migration `023` adds
immutable project Steam depot revisions and freezes their ID and canonical
digest into every newly issued signed release candidate. Migration `024`
freezes a complete project release configuration, creates the workflow-bound
`WAITING_MFA` release from passed main evidence and permits only the one-way
binding of a dispatched MFA approval. All twenty-four migrations are
mounted in numeric order for a newly initialized local PostgreSQL volume.
Docker's initialization directory is not rerun for an existing volume, so an
existing development database must be migrated explicitly before using newer
service code. Application
transactions must set `app.tenant_id`
from an already-authorized session; accepting it directly from a request header
would defeat RLS. Credential values never enter these tables—only Vault refs,
fingerprints, and version IDs do.
