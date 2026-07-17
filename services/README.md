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
retry returns the cached result and `Idempotent-Replayed: true`.

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

The built-in platform default is an exact Claude Code profile. Selection is
`project > tenant > platform > built-in Claude Code`. Defaults only reference
an `ACTIVE` immutable Profile revision and only affect new tasks.

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
the contract probe.

The Agent version approval API requires an exact SHA-256 integrity value,
verified signature flag, passing scan and internal OCI SBOM reference. Agent
images are accepted only for development Worker pools, with exact CLI and
adapter versions and self-update disabled.

## Temporal Worker and Client

The Worker requires a command dispatcher. In production this is an internal
HTTPS service reached through workload identity/mTLS (normally via the service
mesh sidecar); upstream provider keys are never Worker environment variables.

```bash
export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_NAMESPACE=default
export DEVILUDO_CONTROL_PLANE_DISPATCH_URL=https://control-plane.internal/v1/workflow-commands
export DEVILUDO_AGENT_WORKER_DISPATCH_URL=https://agent-worker.internal/v1/workflow-commands
export DEVILUDO_RUNNER_CONTROL_DISPATCH_URL=https://runner-control.internal/v1/workflow-commands
export DEVILUDO_SCM_PROXY_DISPATCH_URL=https://scm-proxy.internal/v1/workflow-commands
export DEVILUDO_STEAM_PUBLISHER_DISPATCH_URL=https://steam-publisher.internal/v1/workflow-commands
node --import tsx services/temporal/src/run-worker.ts
```

Supported environment variables:

- `DEVILUDO_TEMPORAL_TASK_QUEUE` (default `deviludo-game-delivery-v1`)
- The five `DEVILUDO_*_DISPATCH_URL` values above are mandatory and pin each
  command family to its owning service; a command cannot select its own URL.
- `DEVILUDO_MAX_CONCURRENT_ACTIVITIES` and
  `DEVILUDO_MAX_CONCURRENT_WORKFLOWS`
- `DEVILUDO_ALLOW_INSECURE_LOCAL_DISPATCH=1`, only for a loopback HTTP
  dispatcher during local development

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

`ControlPlaneWorkflowHandler` consumes the non-compute commands for ideation,
spec approval, Provider recovery, candidate acceptance, release MFA, external
Steam approvals and cancellation. It persists an exact request-digest-bound
action and deliberately emits no completion signal: only the corresponding
authenticated UI, broker or monitor callback may signal Temporal. A queued
notification therefore cannot be mistaken for user approval.

## Verification

```bash
./node_modules/.bin/tsc -p services/control-plane/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/temporal/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/agent-worker/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/inference-gateway/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/runner-control/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/steam-publisher/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/local-runtime/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/local-agent-runtime/tsconfig.json --pretty false
node --import tsx --test services/control-plane/test/*.test.ts
node --import tsx --test services/temporal/test/temporal-adapter.test.ts
node --import tsx --test services/agent-worker/test/supervisor.test.ts
node --import tsx --test services/inference-gateway/test/gateway.test.ts
node --import tsx --test services/runner-control/test/coordinator.test.ts
node --import tsx --test services/steam-publisher/test/coordinator.test.ts
node --import tsx --test services/local-runtime/test/godot-fixture.test.ts
node --import tsx --test services/local-agent-runtime/test/readiness.test.ts
```

The control-plane tests use Fastify's in-process `inject()` API, so they do not
open a port. The Temporal test bundles the workflow with Temporal's production
webpack bundler, catching non-deterministic or unresolved workflow imports.
