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
  applies a minimal environment allowlist, resolves opaque SecretRefs only at
  process start, redacts JSONL/stderr, and distinguishes cancellation, timeout,
  signal and exit-code failures.
- `local-runtime`: a loopback-only development sidecar. It creates an isolated
  Git repository from the pinned Godot fixture, runs the installed Godot binary
  for import/boot/TestKit/export checks, and writes content-bound manifest,
  JUnit and log evidence below the ignored `.deviludo/` directory. Missing
  export templates remain an explicit release gate.

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

The authentication proxy supplies:

- `x-deviludo-role`: `PlatformAgentAdmin`, `SecurityAdmin`, `TenantAdmin`,
  `ProjectOwner`, or `Auditor`.
- `x-deviludo-actor`: the immutable authenticated principal ID.
- `x-request-id`: an optional tracing ID; Fastify creates one when omitted.

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
export DEVILUDO_ACTIVITY_DISPATCH_URL=https://delivery-dispatch.internal/v1/commands
node --import tsx services/temporal/src/run-worker.ts
```

Supported environment variables:

- `DEVILUDO_TEMPORAL_TASK_QUEUE` (default `deviludo-game-delivery-v1`)
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
history sequence, state and command. `WAITING_PROVIDER`, user acceptance, MFA,
Steam Guard/installation and external Valve approval remain open via Temporal
signals and consume no polling workers. Runtime configuration remains the
locked profile/version/image/model/credential revision carried by the workflow
and activities; the Worker never silently swaps Claude Code and Codex CLI.

## Verification

```bash
./node_modules/.bin/tsc -p services/control-plane/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/temporal/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/agent-worker/tsconfig.json --pretty false
./node_modules/.bin/tsc -p services/local-runtime/tsconfig.json --pretty false
node --import tsx --test services/control-plane/test/control-plane.test.ts
node --import tsx --test services/temporal/test/temporal-adapter.test.ts
node --import tsx --test services/agent-worker/test/supervisor.test.ts
node --import tsx --test services/local-runtime/test/godot-fixture.test.ts
```

The control-plane tests use Fastify's in-process `inject()` API, so they do not
open a port. The Temporal test bundles the workflow with Temporal's production
webpack bundler, catching non-deterministic or unresolved workflow imports.
