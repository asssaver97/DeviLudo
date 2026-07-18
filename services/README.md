# DeviLudo production service entries

This directory contains the long-running Node.js service boundaries that sit
behind the web console:

- `control-plane`: NestJS 11 on Fastify 5, with the exact Agent administration
  API, RBAC, immutable revisions, mutation idempotency and secret-safe error
  handling.
- `temporal`: the durable wrapper around `lib/orchestration/GameDeliveryWorkflow`,
  plus Worker and Client entry points. External waits are signals; no wait path
  polls a database or sleeps in a loop.
- `agent-worker`: a one-run supervisor for the exact Claude Code or Codex CLI
  RuntimeSpec. It uses `shell: false`, validates all workspace/runtime paths,
  verifies the locked CLI version and WorkerImage digest, writes Adapter files
  exclusively with no-follow semantics, applies a minimal environment allowlist,
  resolves opaque SecretRefs only after every static/runtime gate, redacts
  JSONL/stderr, and distinguishes cancellation, timeout, signal and exit-code
  failures.
- `artifact-preparer`: freezes an authoritative SCM snapshot and approved v2
  matrix plan into content-addressed source/test-plan objects, verifies their
  exact publication receipts, then persists the append-only execution lock in
  PostgreSQL under tenant RLS. Its TLS 1.3/mTLS host accepts only a minimal
  Runner workflow trigger and re-resolves approved spec, test-plan, Runner
  toolchain and SCM authority server-side; production broker adapters remain
  explicit mTLS dependencies rather than implicit filesystem or public-Web access.
- `inference-gateway`: verifies short-lived run tokens against the complete
  active immutable run registration, enforces exact protocol/model/Provider/
  credential and remaining budget, and performs fresh DNS/SSRF validation.
  Without a trusted DNS-pinning/Vault connector it fails closed rather than
  using an unpinned HTTP client.
- `runner-control`: registers only admitted mTLS/SPIFFE workloads, rejects E2E
  hosts containing autonomous Agents, signs exact per-platform job envelopes,
  applies independent fencing tokens and derives the final matrix result from
  content-addressed evidence manifests. The public Web process is deliberately
  not a Runner ingress.
- `evidence-archive`: an Agent-free mTLS service that issues at-most-five-minute
  source/evidence grants only after signed-job and signed-fleet authorization,
  verifies S3 checksums at upload commit, independently validates completed
  matrix bundles and stores canonical evidence/repair prompts through immutable
  S3 conditional writes. Production rejects its local filesystem backend.
- `godot-testkit`: the Agent-free, platform-owned physical-game controller. It
  consumes only a signed Runner job, exact source/test-plan grants and pinned
  Godot executable, runs a fixed scenario DSL without a shell, and uploads six
  immutable evidence categories. The repository `tsx` entry is local-only;
  production requires a signed self-contained binary per target OS.
- `scm-proxy`: finalizes a local authoritative candidate and provides the
  production GitHub App core. Signed candidate/acceptance payloads, exact
  repository binding, repository-scoped installation tokens, Git Data/Draft PR
  APIs, evidence-gated merge and lease-claimed idempotency keep credentials and
  branch authority outside Agent workers.
- `steam-publisher`: verifies signed main-SHA RCs and fresh MFA publish
  authorizations, consumes only an exact-App encrypted `config.vdf` SecretRef,
  plans a shell-free SteamCMD private-Beta upload, and dispatches clean Steam
  Client reinstall E2E across the selected matrix before external release gates.
- `local-runtime`: a loopback-only development sidecar. It creates an isolated
  Git repository from the pinned Godot fixture, runs the installed Godot binary
  for import/boot/TestKit/export checks, and writes content-bound manifest,
  JUnit and log evidence below the ignored `.deviludo/` directory. Missing
  export templates remain an explicit release gate.
- `local-agent-runtime`: a loopback-only readiness sidecar. It executes only
  fixed `--version` probes and reports the observed Claude Code/Codex CLI
  versions. Execution stays blocked unless an exact approved version, verified
  WorkerImage identity matching a separately pinned expected digest, a safe
  HTTPS internal inference gateway and explicit opt-in all
  exist; the sidecar has no Agent execution endpoint.

The root application can keep using its lightweight route handlers for the
Sites preview. Production traffic should route `/admin/*` to the control-plane
process and delivery commands to Temporal.

## Control-plane

Start locally from the repository root:

```bash
node --import tsx services/control-plane/src/main.ts
```

It listens on `0.0.0.0:4100` by default. Set
`DEVILUDO_CONTROL_PLANE_HOST`/`DEVILUDO_CONTROL_PLANE_PORT` to override that.
Every mutation requires an `Idempotency-Key` header. Reusing a key with a
different body returns `409 IDEMPOTENCY_KEY_REUSED`; a byte-for-byte equivalent
retry returns the cached result and `Idempotent-Replayed: true`. Production uses
PostgreSQL migration `010` to claim and persist these results atomically across
replicas; only non-production tests use the in-memory implementation. A second
request arriving while the first claim is active receives
`409 IDEMPOTENCY_REQUEST_IN_PROGRESS` with `Retry-After: 1`. Claims use a
five-minute lease so a full Provider probe cannot be duplicated by an early
retry after only a few seconds.

Production catalog mutations now commit the catalog revision, append-only
audit records and the already-redacted idempotency response in the same
PostgreSQL transaction. If the process loses its HTTP response after commit, a
retry replays that exact result instead of creating another installation,
Provider/Profile revision or credential family. Credential result projectors
strip `SecretRef` before the transaction writes the response, and the
interceptor's normal post-handler completion accepts an identical result that
was already committed. Multi-step Provider validation marks `VALIDATING`
without completing the claim, can resume that same state after a process loss,
and completes atomically only with the final `READY` revision.

The trusted authentication proxy supplies a short-lived, request-bound
assertion. The control-plane rejects the request unless the assertion HMAC is
valid, no more than five minutes old, and matches the exact HTTP method and raw
path. Configure its 32-byte-or-longer base64 key through
`DEVILUDO_ADMIN_SESSION_HMAC_KEY`; a browser never receives this key.

Signed headers:

- `x-deviludo-role`: `PlatformAgentAdmin`, `SecurityAdmin`, `TenantAdmin`,
  `ProjectOwner`, or `Auditor`.
- `x-deviludo-actor`: the immutable authenticated principal ID.
- `x-deviludo-tenant-id`: required for TenantAdmin and ProjectOwner.
- `x-deviludo-project-id`: required for ProjectOwner.
- `x-deviludo-admin-session` and `x-deviludo-admin-issued-at`: session binding
  and issuance timestamp.
- `x-deviludo-admin-signature`: base64url HMAC-SHA256 over the canonical role,
  actor, scope, session, timestamp, method and path assertion.
- `x-request-id`: an optional tracing ID; Fastify creates one when omitted.

Platform/Security roles cannot smuggle tenant scope into their assertion;
TenantAdmin can administer only its signed tenant and its BYOK credentials;
ProjectOwner can administer only its signed project. Credential revisions carry
their scope, so a tenant key cannot be reused by another tenant or a platform
Profile.

Routes:

| Method | Route | Primary role |
| --- | --- | --- |
| GET | `/admin/agents` | all admin roles |
| POST | `/admin/agent-versions/discover` | PlatformAgentAdmin |
| POST | `/admin/agent-versions/approve` | PlatformAgentAdmin |
| POST | `/admin/agent-versions/block` | PlatformAgentAdmin |
| POST | `/admin/agent-installations` | PlatformAgentAdmin |
| POST | `/admin/agent-rollouts/:id/advance` | PlatformAgentAdmin |
| POST | `/admin/agent-rollouts/:id/rollback` | PlatformAgentAdmin |
| POST | `/admin/agent-profiles` | scope owner |
| POST | `/admin/agent-profiles/:id/validate` | scope owner |
| POST | `/admin/agent-profiles/:id/activate` | SecurityAdmin |
| POST | `/admin/agent-profiles/:id/disable` | scope owner |
| POST | `/admin/credentials` | SecurityAdmin or TenantAdmin |
| POST | `/admin/credentials/:id/rotate` | SecurityAdmin or TenantAdmin |
| POST | `/admin/credentials/:id/revoke` | SecurityAdmin or TenantAdmin |
| PUT | `/admin/agent-defaults/:scope` | matching scope owner |
| GET | `/admin/agent-health` | all admin roles |
| GET | `/admin/audit` | all admin roles |
| POST | `/admin/inference-requests/:id/reconcile` | SecurityAdmin |
| GET | `/admin/inference-runs/:tenantId/:runId/reconciliation` | SecurityAdmin |

The built-in platform default is an exact Claude Code profile. Selection is
`project > tenant > platform > built-in Claude Code`. Defaults only reference
an `ACTIVE` immutable Profile revision and only affect new tasks.

In production, migration `011` stores Agent versions, installations, Provider
and Profile revisions, credential metadata and defaults as one versioned
catalog aggregate. Mutations lock the latest row and must advance exactly one
revision, preventing lost updates across control-plane replicas. Audit entries
are committed in the same PostgreSQL transaction to a separate append-only
ledger; scoped TenantAdmin and ProjectOwner reads are filtered to their signed
tenant/project. Non-production tests use the seeded in-memory implementation.

`SecretVault` intentionally exposes `write` and `revoke`, but no `read` method.
The bundled implementation is process-isolated for tests; production startup
requires `DEVILUDO_VAULT_INGRESS_URL` and sends the mutable ingress bytes over
the workload-identity/mTLS Vault ingress before zeroing them. API responses contain only masked fingerprints
and version metadata—never a key or the internal `SecretRef`. Provider
validation in production requires `DEVILUDO_INFERENCE_PROBE_URL`, a
credential-free HTTPS endpoint on the internal inference gateway. That gateway
performs DNS pinning, redirect revalidation, authentication, model, streaming,
tools, cancellation, usage and timeout probes while it holds temporary Vault
access. Without it, production validation returns 503; local development uses
the contract probe. The control-plane probe client and Gateway listener both
require TLS 1.3 workload certificates; the control plane sends only the exact
Provider and credential-version identities. The production Gateway is started
with `npm run start:inference-gateway`, uses migrations `028` through `030` for
tenant-RLS run/Provider projections, append-only usage and per-run fenced
request claims, and resolves a five-minute key lease from the fixed mTLS
credential Broker. An expired or transport-ambiguous claim becomes
`INDETERMINATE`; new calls fail closed until a SecurityAdmin supplies an
upstream evidence digest through the idempotent control-plane reconciliation
route. The Gateway either releases a confirmed no-usage request or records
exact token usage at the frozen price, rather than risking an automatic
duplicate charge. See
`services/inference-gateway/.env.example`; PEM and run-token key material must
be file-mounted, never placed directly in environment variables.

## Specification dialogue

`services/spec-dialogue` owns the non-Agent idea conversation. It accepts only
allow-listed mTLS Web identities, stores under PostgreSQL tenant RLS, and calls
a separate mTLS low-latency model Broker without receiving an upstream key or
Base URL. Each turn atomically commits the message pair and immutable draft
spec/test-plan pair. Explicit approval creates approved/frozen successors and
the same authoritative test-plan binding consumed by Artifact Preparer and
Runner Control.

The Agent version approval API requires an exact SHA-256 integrity value,
verified signature flag, passing scan and internal OCI SBOM reference. Agent
images are accepted only for development Worker pools, with exact CLI and
adapter versions and self-update disabled.

## Temporal Worker and Client

The Worker requires a command dispatcher. In production it presents its own
short-lived workload certificate to each internal HTTPS destination; ordinary
`fetch` without a client identity is not accepted. Upstream provider keys are
never Worker environment variables.

```bash
export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_NAMESPACE=default
export DEVILUDO_TEMPORAL_TLS_CA_FILE=/run/secrets/temporal-cluster/ca.crt
export DEVILUDO_TEMPORAL_TLS_CERT_FILE=/run/secrets/temporal-cluster/tls.crt
export DEVILUDO_TEMPORAL_TLS_KEY_FILE=/run/secrets/temporal-cluster/tls.key
export DEVILUDO_TEMPORAL_TLS_SERVER_NAME=temporal.internal
export DEVILUDO_CONTROL_PLANE_DISPATCH_URL=https://control-plane.internal/v1/workflow-commands
export DEVILUDO_AGENT_WORKER_DISPATCH_URL=https://agent-worker.internal/v1/workflow-commands
export DEVILUDO_RUNNER_CONTROL_DISPATCH_URL=https://runner-control.internal/v1/workflow-commands
export DEVILUDO_SCM_PROXY_DISPATCH_URL=https://scm-proxy.internal/v1/workflow-commands
export DEVILUDO_STEAM_PUBLISHER_DISPATCH_URL=https://steam-publisher.internal/v1/workflow-commands
export DEVILUDO_TEMPORAL_DISPATCH_TLS_KEY_FILE=/run/secrets/temporal-dispatch/tls.key
export DEVILUDO_TEMPORAL_DISPATCH_TLS_CERT_FILE=/run/secrets/temporal-dispatch/tls.crt
export DEVILUDO_TEMPORAL_DISPATCH_CA_FILE=/run/secrets/temporal-dispatch/ca.crt
node --import tsx services/temporal/src/run-worker.ts
```

Supported environment variables:

- `DEVILUDO_TEMPORAL_TASK_QUEUE` (default `deviludo-game-delivery-v1`)
- The five `DEVILUDO_*_DISPATCH_URL` values above are mandatory and pin each
  command family to its owning service; a command cannot select its own URL.
- `DEVILUDO_MAX_CONCURRENT_ACTIVITIES` and
  `DEVILUDO_MAX_CONCURRENT_WORKFLOWS`
- Worker, destination-service clients and the command-line client all require
  complete Temporal cluster mTLS material in production. A partial certificate
  set fails startup. `DEVILUDO_ALLOW_INSECURE_LOCAL_TEMPORAL=1` is accepted
  only outside production for the local integration cluster.
- `DEVILUDO_ALLOW_INSECURE_LOCAL_DISPATCH=1`, only for a loopback HTTP
  dispatcher during non-production local development. Production startup
  rejects this flag.

Client examples:

```bash
node --import tsx services/temporal/src/run-client.ts start delivery-001 tenant-001 project-001 windows,linux,macos
node --import tsx services/temporal/src/run-client.ts signal delivery-001 '{"type":"SPEC_READY","specRevisionId":"spec-r8"}'
node --import tsx services/temporal/src/run-client.ts query delivery-001
```

The single `deliverySignal` accepts the repository's complete `DeliverySignal`
union. Each state produces one idempotent activity command keyed by workflow,
history sequence, state and command. Receipts must echo the destination,
workflow, idempotency key and operation before they are accepted. `WAITING_PROVIDER`,
user acceptance, MFA, Steam Guard/installation and all three Steam external
gates remain open via Temporal signals and consume no polling workers. Runtime
configuration remains the locked profile/version/image/model/credential
revision carried by the workflow and activities; the Worker never silently
swaps Claude Code and Codex CLI. Public release is not terminal on dispatch:
the workflow waits for a bound `STEAM_RELEASED` result.

Each destination registers `registerWorkflowCommandRoute` with its fixed
destination, a `WorkflowCommandReceiver`, and an mTLS/SPIFFE authorizer. The
receiver rejects state/command drift and missing PR, evidence, MFA, BuildID or
approval bindings before a handler runs. It returns `202` only after the
handler has durably queued the operation. `PostgresWorkflowCommandInbox`
implements the retry claim under tenant `SET LOCAL` RLS; exact retries replay
the original receipt, while reuse of an idempotency key with a different body
is rejected. The in-memory inbox is explicitly test/local-only.

`PostgresWorkflowCommandQueue` is the concrete durable handler used behind the
receiver. It inserts the complete bound request idempotently, lets only the
fixed destination claim work with `FOR UPDATE SKIP LOCKED`, fences every retry
with a fresh claim token and monotonically increasing attempt, and records
completion/retry/terminal failure under tenant RLS. A receiver therefore never
returns an acceptance receipt for an in-memory-only task.

`WorkflowJobProcessor` is the shared destination-side execution loop. It
claims only one configured destination, exposes a fenced lease heartbeat to
long-running connectors, assigns every Temporal signal the stable
`job:<job-id>` identity, applies bounded exponential retry, and records only
sanitized error codes. If signaling succeeds but queue completion loses its
response, lease reclaim safely replays both the idempotent connector and signal.
Migration `007_workflow_job_heartbeats.sql` permits same-token heartbeats while
still requiring a new token and incremented attempt for an expired-lease
reclaim.

`WorkflowJobWorkerHost` supplies the long-running process loop around that
single-job processor. It accepts tenant assignments only from an injected,
trusted control-plane source (never an owner-role database scan), validates and
deduplicates them, drains productive cycles immediately, backs off on an empty
queue or infrastructure error, reports only bounded diagnostic codes, and
stops through an `AbortSignal`. Only one loop may run per host instance.

`WorkflowDestinationRuntime` now composes the receiver, PostgreSQL inbox/job
queue, Temporal signal client and long-running consumer into one fail-closed
service host. `/healthz` becomes ready only after PostgreSQL and the current
tenant assignment have passed their probes. SIGINT/SIGTERM drains the loop,
closes Fastify, then closes the Temporal and PostgreSQL connections. The
Temporal worker uses a direct TLS 1.3 client certificate; the destination
extracts the one SPIFFE URI SAN from the authorized peer certificate and does
not trust identity headers.

Tenant access is delivered as a short-lived Ed25519-signed manifest bound to
the exact workload ID and destination. The manifest is re-read and verified on
every polling cycle, expires within fifteen minutes, rejects duplicate or
non-UUID tenant IDs, and never asks a database-owner connection to enumerate
RLS tenants. A read-only public key is mounted on the Worker; its private
signing key remains in the control plane/KMS.

The concrete destination entries now include the control-plane action service,
Agent execution dispatcher, durable Runner attempt scheduler, SCM merge
dispatcher and Steam release dispatcher:

```bash
npm run start:control-plane-workflow
npm run start:agent-worker-workflow
npm run start:runner-control-workflow
npm run start:scm-proxy-workflow
npm run start:steam-publisher-workflow
```

They require the destination TLS, signed-assignment and database variables in
`services/temporal/.env.example`. The Agent destination additionally requires
the isolated execution Broker mTLS settings and remains unready if that Broker
cannot prove its exact health identity. For source modes the Runner destination
first invokes the isolated Artifact Preparer, then resolves the authoritative
SCM/Steam source receipt and execution lock under tenant RLS, creates a
request-digest-bound `e2e_attempts` row and heartbeats while the dedicated mTLS
Runner ingress produces immutable content-addressed evidence. It never invokes
the in-memory coordinator in production. The SCM destination sends only the
frozen candidate/evidence/acceptance identifiers over mTLS to an isolated
GitHub App Broker, requires the Broker's exact health identity, and accepts only
an actual default-branch head plus a freshly derived main source digest. The
Steam destination similarly sends only immutable evidence/MFA/approval IDs to
an mTLS-isolated Broker; passwords, Guard codes, `config.vdf` and Steam build
account access never enter the Temporal host. No placeholder connector reports
successful work.

The Runner ingress's separate evidence dependency has its own production entry:

```bash
npm run start:evidence-archive
```

It admits only explicitly allowed SPIFFE workloads, derives every tenant S3 key
server-side, signs direct HTTPS requests with SigV4 and verifies the complete
stored object on an idempotent retry. See
`services/evidence-archive/.env.example`.

`ControlPlaneWorkflowHandler` consumes the non-compute commands for ideation,
spec approval, Provider recovery, candidate acceptance, release MFA, external
Steam approvals and cancellation. It persists an exact request-digest-bound
action and deliberately emits no completion signal: only the corresponding
authenticated UI, broker or monitor callback may signal Temporal. A queued
notification therefore cannot be mistaken for user approval.

Those authoritative services complete an action through the internal mTLS-only
`POST /v1/workflow-actions/:actionId/complete` route. The peer certificate's
SPIFFE URI maps to exactly one fixed source role through
`DEVILUDO_WORKFLOW_COMPLETION_SPIFFE_SOURCES_JSON`; a request body cannot choose
or override that role. Completion validates the frozen action binding, writes
the exact signal and marks the action complete in one PostgreSQL transaction.
An auxiliary leased outbox worker then signals Temporal and records delivery;
process loss before or after signaling is safe because both the outbox signal
identity and the workflow's signal replay handling are idempotent. Browser
traffic never reaches this route directly, and malformed approval payloads do
not become availability errors.

## Verification

```bash
./node_modules/.bin/tsc -p services/control-plane/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/temporal/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/agent-worker/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/inference-gateway/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/runner-control/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/evidence-archive/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/steam-publisher/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/local-runtime/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/local-agent-runtime/tsconfig.json --pretty false
node --import tsx --test services/control-plane/test/*.test.ts
node --import tsx --test services/temporal/test/temporal-adapter.test.ts
node --import tsx --test services/agent-worker/test/supervisor.test.ts
node --import tsx --test services/inference-gateway/test/*.test.ts
node --import tsx --test services/runner-control/test/coordinator.test.ts
node --import tsx --test services/evidence-archive/test/*.test.ts
node --import tsx --test services/steam-publisher/test/coordinator.test.ts
node --import tsx --test services/local-runtime/test/godot-fixture.test.ts
node --import tsx --test services/local-agent-runtime/test/readiness.test.ts
```

The control-plane tests use Fastify's in-process `inject()` API, so they do not
open a port. The Temporal test bundles the workflow with Temporal's production
webpack bundler, catching non-deterministic or unresolved workflow imports.
