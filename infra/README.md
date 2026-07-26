# DeviLudo infrastructure reference

`docker-compose.yml` is a local integration environment, not a production
deployment. Copy `.env.example` to a private `.env`, replace its disposable
localhost passwords, then start and verify the stack from the repository root:

```bash
npm run infra:up
npm run infra:status
```

PostgreSQL, Redis, Temporal, MinIO, Vault and the OpenTelemetry health endpoint
are exposed only on `127.0.0.1`. Host-started DeviLudo services therefore use
the same loopback `DATABASE_URL`, authenticated `REDIS_URL`, `TEMPORAL_ADDRESS`,
`S3_ENDPOINT`, `VAULT_ADDR` and telemetry values as the Compose stack.
`infra:up` follows dependency startup with the repository migration runner. The
status command authenticates to PostgreSQL and Redis, proves migration `063` is
present, and checks every other dependency without printing credentials. Stop
the containers with `npm run infra:down`.

Production replaces each container with an HA managed service: PostgreSQL with
PITR and separate owner/migration/application roles, a three-node Temporal
cluster, TLS Redis, versioned/locked S3 buckets, auto-unseal Vault/KMS, and an
OTel collector exporting to the operator's telemetry backend. Worker pools,
E2E runners, inference connectors, non-Agent specification model Brokers, Steam
publishers and release-signing depot finalizers live in separate network
segments and service accounts.

Physical Runner, Godot TestKit and Steam Client Connector are not shipped in
the control-plane image. The Connector is installed only on Steam-capable hosts.
Each target host uses the fixed SEA candidate builder and dedicated native
release trust policy described in `docs/runner-native-release.md`. The checked-in
Runner trust template is revoked; production distributes an independently
reviewed policy digest and accepts no raw or ad-hoc-signed candidate.

The OS-specific Steam UI bridge uses a separate reviewed policy and KMS key.
`steam-native-bridge-trust-policy.example.json` is also intentionally revoked;
Connector startup requires its exact out-of-band digest and rejects
revoked/expired signing keys before probing the bridge.

Every Node service start command registers the platform-owned OpenTelemetry SDK
before application imports. Production processes fail closed without a fixed
OTLP traces endpoint. The recommended deployment gives each workload a
loopback Collector sidecar; only that Collector holds any upstream telemetry
authentication and TLS material. See `docs/observability.md`.

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
binding of a dispatched MFA approval. Migrations `025`–`043` complete Steam
release lifecycle authority, inference reconciliation, specification dialogue,
Agent configuration, source/candidate/feedback/acceptance/merge projections,
GitHub authorization anti-replay, and atomic project-to-repository onboarding.
Migration `044` adds invite-only GitHub identities, tenant memberships,
single-use login intents and revocable platform sessions. Raw invitation,
OAuth state, PKCE and session values never enter PostgreSQL; all five identity
tables force tenant RLS. Migrations `045`–`047` isolate secret brokerage and
make explicit same-Agent Provider failover both immutable and auditable.
Migration `048` atomically binds a failed clean-Steam-client evidence bundle to
an append-only release revocation before the Build and Release may enter
`FAILED`.
Migrations `049`–`050` add cross-service delivery cancellation revocation and
the projection-bound user request ledger. Migration `051` persists ordered,
fresh Steam external-approval observations. Migrations `052`–`053` add exact
Provider recovery checks and durable bounded retry scheduling. Migration `054`
adds the tenant-RLS, append-only Steam depot finalization ledger, with one fenced
content-addressed operation per release/platform and no signing credentials.
Migration `055` adds the prompt-free, tenant-RLS specification model generation
ledger with replay, released and indeterminate charging states. Migration `056`
adds monotonic dispatch generations and append-only SecurityAdmin no-usage or
exact-usage reconciliation receipts; a trigger rejects release without the
matching generation receipt. Migration `057` requires every approved test-plan
binding to reference a canonical Runner toolchain whose Godot version and exact
export-template matrix match the approval. Migration `058` adds the isolated,
tenant-RLS Runner Toolchain Publisher ledger. The service revalidates signed
tenant assignment, while insert guards bind every new revision to current
ONLINE Runner capabilities and the exact supply-chain evidence. Migration `059`
adds one-time, actor-bound Steam project configuration intents and immutable
Depot/Release revisions without storing Beta branch passwords. Migration `060`
marks pre-migration Agent runs as historical, forces every ordinary new Run to
carry the exact AgentVersion/Adapter supply-chain proof in its primary and
fallback lock, and permits proof-free repair descendants only when a database
trigger verifies the same immutable runtime identity against a historical
predecessor in the same tenant/project. Migration `061` creates a
privilege-revoked, update/delete-protected ledger and baselines the exact
SHA-256 of migrations `001`–`060`. Migration `062` adds the immutable,
zero-live-lease authorization ledger used by signed native Runner upgrades.
Migration `063` adds the append-only, tenant-RLS audit ledger for attempt-bound
Agent microVM bootstrap images; it records only request/image digests and never
persists image bytes, certificates, private keys, tokens or SecretRefs.
Migrations `001`–`061` remain mounted in numeric order for a newly initialized
local PostgreSQL volume; the post-start migrator records `061` and applies
`062` and `063`. Every later migration is executed under one
PostgreSQL advisory lock and writes its version, filename and digest in the same
transaction as its schema change. A gap, edited historical file, unknown future
row, concurrent migrator or failed statement aborts startup.

Docker's initialization directory is not rerun for an existing volume. An old
local volume with schema 060 but no ledger must be backed up and explicitly
adopted once with `npm run db:adopt-local`; this path is loopback-only and is
rejected when `NODE_ENV=production`. Normal upgrades use `npm run db:migrate`.
Production runs that command as a one-shot deployment job before any new service
revision. It must receive a distinct owner/migration-role URL through
`DEVILUDO_MIGRATION_DATABASE_URL_FILE`; application `DATABASE_URL` is rejected,
TLS verification cannot be disabled, and optional CA/client credentials are
file-mounted through the three `DEVILUDO_MIGRATION_POSTGRES_*_FILE` variables.
Application
transactions must set `app.tenant_id`
from an already-authorized session; accepting it directly from a request header
would defeat RLS. Credential values never enter these tables—only Vault refs,
fingerprints, and version IDs do.

## Production control-plane image

The repository root `Dockerfile.control-plane` is built only through
`npm run image:build-control`. The builder refuses a floating base, a Node
release older than 22.13, a non-Debian-slim base, credentials embedded in an
image name, `latest`, or a destination tag not exactly derived from the package
version and 40-character source revision. It always uses `docker buildx` with
fresh base resolution, no cache, maximum provenance, an SBOM and registry push;
success returns the immutable registry digest together with Dockerfile and
package-lock digests.

The image installs production dependencies from the lockfile with lifecycle
scripts disabled, runs as the base image's unprivileged `node` user and accepts
no runtime arguments. `DEVILUDO_SERVICE` selects one explicitly classified
control workload. The entrypoint fails closed when local-test authority is
present and never admits Agent execution workers or guests, the privileged
Agent supply-chain Broker or native policy, Artifact Preparer, physical Runner, Godot TestKit, Steam executor,
signing finalizer, Steam Client connector, install services, hosted Web, or
localhost sidecars. These external workloads require separately signed images
and node pools. Overriding this entrypoint is therefore a deployment-policy
violation, not a supported way to run them.

The same image contains the migration files so a one-shot deployment Job can
override the command to run `node scripts/production/migrate-postgres.mjs`
before control workloads are released. Only that Job receives the migration
credential files. A normal control container receives application credentials
for its own role and never receives the migration role.

The Agent microVM credential issuer is never added to that shared image. Build
`Dockerfile.agent-microvm-credential-issuer` only through
`npm run image:build-agent-microvm-credential-issuer -- ...`; the builder binds
digest-pinned Node and internal e2fs toolchain bases, the source-derived tag,
maximum BuildKit provenance and SBOM into its receipt. The workload must receive
a private tmpfs at `/run/deviludo-credential-images` plus file-mounted TLS and
attestation material; it runs as UID/GID 1000 and accepts no alternate command.
Its production release is separately locked and authorized as documented in
[`docs/agent-microvm-credential-issuer-release.md`](../docs/agent-microvm-credential-issuer-release.md):
four immutable runtime resources are bound by UID/resourceVersion, a distinct
Ed25519 policy authorizes the exact image/scope, and every server-side apply
stage rechecks both before mutation. The rendered Pod uses a private tmpfs for
credential images and a default-deny network policy; allow rules remain an
externally reviewed cluster input.

Each production Agent polling process also mounts an immutable
[`agent-execution-worker-binding.example.json`](agent-execution-worker-binding.example.json)-derived
placement file. Its exact digest and the independently signed Guest identity
jointly constrain the Installation IDs that process may claim. This host-side
gate is what makes Claude/Codex selection, canary rollout, draining and rollback
effective at the queue boundary rather than only in the admin projection.

`npm run lock:control-runtime` first snapshots only the kind, name, UID,
resourceVersion and immutable flag of the revision-suffixed ConfigMaps and
Secrets; it never reads Secret data. `npm run deploy:control` consumes that lock
and the image receipt and renders an ordered Kubernetes release bundle without
contacting a cluster. An actual apply requires
`--apply`, an explicit kubeconfig context and a short-lived Ed25519 authorization
from the dedicated mTLS Vault/KMS Broker. The authorization binds the exact
receipt, runtime-lock digest, context, namespace, service set and replicas; local
verification happens before any `kubectl` call. The live immutable resource
identities are then rechecked before every mutating stage. It server-side-applies the
restricted Namespace and tokenless ServiceAccount, waits for the exact migration
Job, then applies only the allow-listed control Deployments/ClusterIP Services
and waits for the receipt revision. It performs no delete or prune operation.
The generated namespace-wide default-deny NetworkPolicy requires externally
managed least-privilege allow rules before migration or service startup.
The target namespace's registry, migration and per-service ConfigMap/Secret
objects are revision-suffixed, immutable external production inputs; see
[`docs/production-control-release.md`](../docs/production-control-release.md).

## Agent Execution Worker native boundary

The Linux KVM host Worker is released separately from the control image, the
microVM Launcher and the Guest rootfs. Build and finalize it only through
`build:agent-execution-worker-native` and `finalize:agent-execution-worker-native`;
the revoked-by-default trust template is
`agent-execution-worker-native-trust-policy.example.json`. Production executes
the resulting single-file bundle directly. It verifies its own bytes, build
receipt and distinct Ed25519 release before creating any external client. See
[`docs/agent-execution-worker-native-release.md`](../docs/agent-execution-worker-native-release.md).

## Steam Workflow Executor image boundary

The irreversible Steam workflow executor is excluded from the shared control
image. Build its dedicated non-root image only with
`image:build-steam-workflow-executor`; its immutable receipt binds the pushed
Registry digest, exact Node base, source, Dockerfile and lockfile plus maximum
BuildKit provenance and SBOM. The image deliberately omits SteamCMD, the native
publisher, `config.vdf` and credentials; those remain separate read-only runtime
inputs. See [`docs/steam-workflow-executor-image.md`](../docs/steam-workflow-executor-image.md).

## Artifact Preparer image boundary

Runner source input preparation is not admitted to the shared control image.
`npm run image:build-artifact-preparer` builds the dedicated
`Dockerfile.artifact-preparer` from a digest-pinned Node 22.15+ Debian-slim base
and a source-derived immutable tag. The build always pushes with maximum
provenance and an SBOM, then emits a receipt binding the registry digest, base,
source revision, platform, Dockerfile and lockfile. The fixed non-root entrypoint
starts only `artifact-preparer`, rejects arguments and local-test authority, and
fixes its work root to `/var/lib/deviludo/artifact-preparer-work`.

Production must mount that work root as bounded ephemeral storage, keep the root
filesystem read-only and provide only the file-mounted mTLS/assignment inputs
documented in `services/artifact-preparer/.env.example`. Building a receipt does
not authorize deployment; runtime resource locking and signed deployment
authorization remain a separate required release stage.

The first release-stage boundary is implemented by
`npm run lock:artifact-preparer-runtime`. It requires an explicit kube context
and exact 12-character configuration revision, reads only custom-column
metadata and binds the UID/resourceVersion of four revision-suffixed immutable
objects: registry Secret, runtime ConfigMap, environment Secret and file Secret.
It never reads Secret contents or falls back to the current context. The lock is
digestible and its live identities must be rechecked by the deployer; a lock by
itself grants no mutation authority.

Artifact Preparer release signing uses the separate revoked-by-default
`infra/artifact-preparer-release-trust-policy.example.json`. Inspect it with
`npm run inspect:artifact-preparer-release-trust`, then use
`npm run authorize:artifact-preparer` to request a maximum-30-minute Ed25519
authorization from the dedicated mTLS KMS route. Claims bind the receipt and
base-image digest, runtime lock, explicit context, namespace, replicas and
timeout; control-plane or Agent signing keys are not interchangeable.

`npm run deploy:artifact-preparer -- --render` performs no cluster operation.
An actual `--apply` requires the matching authorization, policy and digest,
revalidates them plus the live locked objects before each write, and applies
only the restricted Namespace, tokenless ServiceAccount, default-deny policy,
ClusterIP Service and digest-pinned Deployment. The pod uses a read-only root,
drops every capability, mounts no host path and keeps source material in a
bounded ephemeral volume. It never deletes, prunes, execs or uses an implicit
context. External mTLS ingress and minimum egress policies remain deliberately
out of band, so missing network authority fails closed.

## Privileged Agent supply-chain release

The Agent supply-chain Broker is never admitted to the shared control image. A
dedicated `Dockerfile.agent-supply-chain` is built only by
`npm run image:build-agent-supply-chain`; it requires digest-pinned Node 22.13+
and internal `agent-supply-chain-toolchain` bases, an exact platform version and
a source-derived destination tag. Its fixed entrypoint starts only the Broker,
rejects arguments and local-test authority, and disables CLI self-updates.

The target namespace must pre-provision four revision-suffixed immutable
objects (registry Secret, runtime ConfigMap, environment Secret and file Secret)
plus a revision-suffixed PVC containing the signed native executable and release
files. `npm run lock:agent-supply-chain-runtime` reads metadata only and binds
all five UID/resourceVersion pairs to one explicit kube context. The PVC is
mounted read-only; the platform-owned work directory is a bounded ephemeral
volume and must never be a host path or runtime socket.

`npm run deploy:agent-supply-chain -- --render` is side-effect free. A real
apply additionally needs a maximum-30-minute authorization from a distinct mTLS
KMS route and the exact digest of the separately reviewed Agent supply-chain
release trust policy. Authorization binds the image receipt, toolchain base,
runtime lock, context, namespace and replicas. Before each of the three writes,
the deployer re-verifies both signature and live resource identities. It applies
only a restricted namespace, tokenless ServiceAccount, default-deny policy,
ClusterIP Service and one dedicated Deployment; it never deletes, prunes, execs
or uses the current context. SecurityAdmin-managed ingress/egress allow policies
and remote mTLS endpoints for BuildKit, registry, KMS and Fleet are external
prerequisites; the generated default-deny policy intentionally fails closed.
