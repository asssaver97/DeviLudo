# Runner control and evidence ingress

This service core models the production E2E trust boundary without pretending
that a localhost process is a real Windows/Linux/macOS fleet.

- Runner identity comes from an authorized mutual-TLS peer certificate and a
  single SPIFFE URI SAN. HTTP headers are not an identity source.
- Registration fixes OS, architecture, Godot binary, export-template image,
  GPU/display/audio and runner-image digests. Any installed autonomous Agent is
  rejected.
- Steam-capable machines additionally bind exact Connector/bridge versions,
  controller contract, native binary, automation policy and supply-chain
  evidence digests into the immutable capability digest. A machine without that
  declaration can run source E2E but cannot lease `STEAM_CLEAN_INSTALL`.
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

The matching archive server is implemented in `services/evidence-archive` and
starts with `npm run start:evidence-archive`. It admits only the configured
Runner-ingress SPIFFE identity, revalidates the complete canonical bundle and
uses no-overwrite S3 writes; it is not mounted into this service or the public
Web application.

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
      "tenantIds": ["11111111-1111-4111-8111-111111111111"],
      "steamClientConnectorIdentity": {
        "spiffeId": "spiffe://deviludo.internal/steam-connector/runner-linux-1",
        "certificateFingerprint": "<different 64 lowercase hex>"
      }
    }]
  },
  "signature": "<Ed25519 base64url over canonical claims>"
}
```

`steamClientConnectorIdentity` is `null` on source-only machines. Steam grant
redemption requires this distinct signed identity; the Runner's primary
certificate cannot be reused as a Connector certificate.

The separately authenticated Runner ingress remains the only owner of platform
leases/events and terminal attempt writes; artifact bytes belong in the
content-addressed object store. It must expose those operations only behind a
dedicated mTLS listener; the public web application route is not runner ingress.

`PhysicalRunnerAgent` is the portable protocol state machine intended to run
unchanged on Windows, Linux and macOS. It verifies the Ed25519 job before
invoking an injected, idempotent TestKit executor and independently checks the
tenant, Runner ID, platform, capability digest, exact Godot version and export
template digest. It persists STARTED, evidence and completion through a
`PhysicalRunnerJournal` before transmission, so a process restart replays the
same sequence numbers, timestamps, manifest and fencing token rather than
inventing a second result. `MemoryPhysicalRunnerJournal` exists only for the
contract suite; a deployment must provide an OS-local durable implementation.

`MtlsPhysicalRunnerIngressClient` is the corresponding Runner-side transport.
It pins one HTTPS origin, uses TLS 1.3 with the machine workload certificate,
follows no redirects and calls only `/v1/register`, `/v1/lease`,
`/v1/evidence` and `/v1/events`. It never sends SPIFFE or Runner identity in an
HTTP header; the server derives both from the certificate. Its certificate
paths use the operating system's absolute-path rules so the same client can be
configured on all three target systems. The portable contract suite exercises
all three platform identities, journal replay, signature tampering,
cross-tenant jobs and capability drift; this is not a substitute for the final
physical-machine E2E gate.

`FilePhysicalRunnerJournal` is the production journal implementation. Every
attempt/fencing-token record is strict canonical JSON authenticated with a
machine-local HMAC key, written through an fsynced temporary file and atomic
rename, and restricted to the Runner service account. State can advance only
from STARTED to evidence to completion; rollback, a different job digest,
another machine key or manual file edits fail closed. The server-signed job is
rechecked independently after journal recovery.

`LockedTestKitExecutor` is the production execution boundary. Before every
attempt it hashes the platform-owned TestKit controller and Godot executable
and compares them to the immutable lock. It invokes only
`deviludo-testkit run --request-file <fixed> --output-file <fixed>` through
`execFile` with `shell: false`, a minimal environment, private per-attempt home
and bounded output/timeout. The controller must download the locked Source or
Steam build and upload logs/JUnit/timeline/screenshots/video/export to the
artifact service; its result is accepted only when it echoes the exact job,
TestKit and Godot digests. A prior exact result is reused after restart, while
an existing request with different bytes is rejected.

The request now carries the full server-signed job envelope, not a mutable bare
payload. `MtlsTestKitArtifactClient` uses that envelope to request short-lived,
job-bound source/test-plan download and evidence-upload grants from the isolated evidence
archive. It pins the configured HTTPS transfer origins, follows no redirects,
streams through bounded files, verifies SHA-256 before materializing input,
rehashes evidence after upload before commit, and accepts only the archive's
exact object binding. The TestKit child receives only the explicit artifact
endpoint, certificate/CA file paths and transfer limits from the host; arbitrary
Runner environment variables are rejected and API keys are not inherited.
The child may inherit only the explicit graphical/audio session allowlist needed
by a physical Linux display host; those values are filtered again before Godot
starts. See `services/godot-testkit/README.md` for the fixed DSL, evidence and
native packaging contract.

Steam clean-install jobs take a separate route inside the same locked TestKit.
The child receives only a fixed mTLS Steam Connector origin, certificate/CA
file paths and a staging root. It sends the signed BuildID-bound job and frozen
plan; the platform Connector returns no Steam credentials, only a canonical
receipt and bounded local evidence paths under that staging root. TestKit
requires clean-client reset, exact installation, production boot and platform
suite receipts, then packages the installed tree instead of downloading source
or creating a second export. Partial Connector configuration is rejected before
the child starts. The physical Runner matches the declared Connector/bridge
versions, controller contract and artifact/policy/evidence digests to its
machine lock and authenticates the exact Connector
`/healthz` service over mTLS before advertising READY. Source-only Runners must
omit the entire Connector environment group.

Run the machine daemon with `npm run start:physical-runner`. Startup verifies
that the configured platform/architecture match the actual Node host, loads
all TLS/HMAC/public-key material from files, probes both executable digests,
the authenticated ingress `/health` and the optional Steam Connector, then polls serially with bounded
exponential backoff. Diagnostics contain only stable codes. Configuration
templates are `.physical-runner.env.example` and
`physical-runner.config.example.json`; they intentionally contain no private
key or platform credential.

`RunnerControlWorkflowHandler` maps durable workflow jobs to three distinct
modes: candidate matrix, merged-main release gate and clean Steam install.
Before either source mode can schedule an attempt it sends only the immutable
workflow trigger to the isolated Artifact Preparer over mTLS, heartbeats the
workflow lease while preparation runs, and verifies the exact execution-lock
receipt. The Preparer re-resolves source/spec/test/toolchain authority from
PostgreSQL; Runner Control cannot supply those executable fields. Steam mode
uses a separate mTLS Steam-owned preparation endpoint: it receives only the
run/request/commit/BuildID/matrix tuple and returns an opaque install grant plus
an immutable execution-lock receipt. Account credentials, Guard values,
`config.vdf` and branch passwords never enter Runner Control.
Receipts must repeat the exact commit, Steam BuildID (when applicable) and
ordered target matrix. Candidate failure emits a repair signal; main or Steam
failure is terminal so neither can be mistaken for reusable candidate evidence.

Run the production workflow destination with `npm run
start:runner-control-workflow`. In addition to the shared destination TLS,
signed tenant-assignment, Temporal and PostgreSQL variables, it accepts
the `DEVILUDO_RUNNER_ARTIFACT_PREPARER_*` and
`DEVILUDO_RUNNER_STEAM_PREPARER_*` file-mounted mTLS variables in
`.env.example`, plus
`DEVILUDO_RUNNER_ATTEMPT_POLL_SECONDS` (default 5) and
`DEVILUDO_RUNNER_ATTEMPT_MAX_WAIT_SECONDS` (default 7200). A timeout retries the
durable workflow job; it never changes the attempt binding.
