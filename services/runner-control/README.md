# Runner control and evidence ingress

This service core models the production E2E trust boundary without pretending
that a localhost process is a real Windows/Linux/macOS fleet.

- Runner identity comes from an authorized mutual-TLS peer certificate and a
  single SPIFFE URI SAN. HTTP headers are not an identity source.
- Registration fixes OS, architecture, Godot binary, export-template image,
  GPU/display/audio and runner-image digests. Any installed autonomous Agent is
  rejected.
- A matrix attempt creates a separate lease and monotonically increasing
  fencing token for every selected platform. Re-leasing one platform makes all
  late events from its previous runner stale.
- Job envelopes are canonicalized and Ed25519-signed. They bind the complete
  spec/test/source/commit matrix, source object digest, TestKit, export template,
  runner capability, expiry and required evidence set.
- A runner can terminate only its platform stream. It cannot send
  `ATTEMPT_COMPLETED`; the coordinator derives PASSED/FAILED after all selected
  platforms terminate.
- `PLATFORM_COMPLETED` is accepted only after a content-addressed manifest binds
  logs, JUnit, deterministic inputs, screenshots, video and production export
  to the exact lease. The coordinator then creates the immutable bundle.

`RunnerMatrixCoordinator` uses in-memory maps only as a deterministic contract
implementation for the lease/event trust rules. `PostgresRunnerWorkflowPort`
is the production Temporal-side scheduler: under forced tenant RLS it resolves
the candidate, actual merged-main, or Steam Build source receipt, creates one
idempotent immutable attempt, renews the workflow lease while waiting, and
returns only a terminal content-addressed evidence bundle whose manifest digest
and complete source/spec/test/matrix binding verify. It never runs a localhost
fixture or fabricates a passing result. Missing SCM/Steam receipts and old merge
receipts without `main_source_digest` fail closed.

Before it inserts a workflow attempt, the scheduler also requires one
append-only `RunnerExecutionLock` addressed by the tenant-scoped workflow
request digest. That lock fixes the prepared source artifact or one-time Steam
install grant, exact Godot version, signed TestKit, per-platform export-template
digests and build/SBOM/vulnerability/license evidence. The attempt stores a
same-tenant foreign key and digest for the lock. Missing locks remain retryable;
malformed, tampered or input-mismatched locks are terminal conflicts.

`PostgresRunnerIngressStore` is the production transaction core for physical
registration and leasing. Admission fixes the SPIFFE/certificate/capability
binding, a server-side assignment policy authorizes the tenant, and forced RLS
selects an eligible attempt with `SKIP LOCKED`. It increments the platform
fencing token, derives a v2 Source/Steam job only from the execution lock,
includes all supply-chain digests, signs it with Ed25519 and persists the whole
envelope. A retry re-verifies and returns those identical signed bytes instead
of issuing a second lease. Evidence can be written only after `STARTED` and is
validated against that signed job before occupying the lease's immutable slot.
Events then advance under the attempt row lock, exact fencing token and
monotonic sequence. A Runner can end only its own platform; the store verifies
every latest platform job and manifest, archives the content-addressed bundle,
and derives the matrix result server-side. This store still requires the
dedicated mTLS HTTP adapter described below; it is never mounted in the public
Web process.

`createRunnerIngressHttpsServer` provides that dedicated boundary. It forces
TLS 1.3, `requestCert` and `rejectUnauthorized`, bounds headers/body/timeouts and
derives the Runner identity exclusively from the authorized peer certificate.
Its authenticated API is `POST /v1/register`, `/v1/lease`, `/v1/evidence` and
`/v1/events`; `GET /health` also requires a client certificate. Identity-like
HTTP headers are ignored and internal rejection details are reduced to bounded
error codes. `SignedRunnerFleetPolicy` reloads an at-most-15-minute Ed25519
manifest for every admission and lease decision. Each sorted entry fixes one
Runner ID to its exact SPIFFE ID, certificate fingerprint, capability digest,
platform and sorted tenant allow-list; signature, expiry or ordering failure
closes both registration and tenant assignment.

`npm run start:runner-ingress` is the production host. It loads the server
certificate, Runner client CA and Ed25519 job private key only from absolute
files, composes the PostgreSQL store and signed fleet policy, and talks to a
separate evidence archive over client-certificate-authenticated HTTPS. The
archive owns object-store credentials and must echo the exact tenant, project,
attempt and bundle digest before its receipt is accepted. Startup probes all
three dependencies before listening; the certificate-authenticated `/health`
route repeats those probes and returns 503 on drift. See
`services/runner-control/.env.example`. The public Web route remains a
deliberate 503.

The fleet manifest envelope is strictly shaped as follows. `issuedAt` to
`expiresAt` may span no more than 15 minutes, IDs must be unique and sorted,
and the file must be atomically replaced before expiry:

```json
{
  "keyId": "runner-fleet-key-01",
  "claims": {
    "kind": "deviludo-runner-fleet",
    "version": 1,
    "revision": 42,
    "issuedAt": "2030-01-01T00:00:00.000Z",
    "expiresAt": "2030-01-01T00:10:00.000Z",
    "runners": [{
      "runnerId": "runner-linux-1",
      "spiffeId": "spiffe://deviludo.internal/e2e/runner-linux-1",
      "certificateFingerprint": "<64 lowercase hex>",
      "capabilityDigest": "<64 lowercase hex>",
      "platform": "linux",
      "tenantIds": ["11111111-1111-4111-8111-111111111111"]
    }]
  },
  "signature": "<Ed25519 base64url over canonical claims>"
}
```

The separately authenticated Runner ingress remains the only owner of platform
leases/events and terminal attempt writes; artifact bytes belong in the
content-addressed object store. It must expose those operations only behind a
dedicated mTLS listener; the public web application route is not runner ingress.

`RunnerControlWorkflowHandler` maps durable workflow jobs to three distinct
modes: candidate matrix, merged-main release gate and clean Steam install.
Receipts must repeat the exact commit, Steam BuildID (when applicable) and
ordered target matrix. Candidate failure emits a repair signal; main or Steam
failure is terminal so neither can be mistaken for reusable candidate evidence.

Run the production workflow destination with `npm run
start:runner-control-workflow`. In addition to the shared destination TLS,
signed tenant-assignment, Temporal and PostgreSQL variables, it accepts
`DEVILUDO_RUNNER_ATTEMPT_POLL_SECONDS` (default 5) and
`DEVILUDO_RUNNER_ATTEMPT_MAX_WAIT_SECONDS` (default 7200). A timeout retries the
durable workflow job; it never changes the attempt binding.
