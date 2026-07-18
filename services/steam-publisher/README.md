# DeviLudo Steam publisher

This service is the Agent-free trust boundary for Steam delivery. It accepts
only an Ed25519-signed RC bound to the merged main SHA and authoritative release
evidence, plus a separate short-lived publish authorization backed by fresh MFA.

The coordinator:

- verifies tenant, project, release, App ID, main/source/spec/test-plan/evidence
  digests, exact target matrix and one depot artifact per selected platform;
- accepts only an active dedicated build-account session restricted to the
  exact App ID and the Steamworks build permissions;
- persists only a Vault `SecretRef` for the enrolled `config.vdf`; Steam account
  passwords, Guard codes and session plaintext never enter the Web API;
- rejects `default`/`public` and uploads only to a fixed password-protected Beta
  branch under a lease-claimed idempotency key. The same operation key/digest is
  passed to the Connector so it reconciles an existing Build after interruption
  instead of uploading a duplicate;
- schedules clean Steam Client installs on every selected OS and requires a
  second authoritative evidence bundle before reaching external approvals;
- leaves Valve review, first release and default-branch confirmation as explicit
  human/external gates.

Production upload claims use `PostgresSteamPublishOperationStore`, not the
contract-only in-memory store. It inserts once under forced tenant RLS, locks the
claim row before every decision, fences concurrent replicas with a UUID lease,
reclaims only after expiry and accepts a completion replay only when the entire
private-Beta receipt is identical. Migration `019_steam_publish_claims.sql`
makes tenant/project/release/request bindings immutable, prevents reclaiming a
completed upload and forbids deletion. A process restart therefore cannot turn
one approved release into a duplicate SteamPipe upload.

`buildSteamCmdRuntimePlan()` produces a shell-free invocation using `+login
<account>` without a password and a platform-generated VDF build script. The
encrypted `config.vdf` SecretRef is materialized only inside the isolated Steam
publisher runtime and is not placed in arguments, environment values or logs.

The Web control plane enables Steam enrollment only when both the internal
broker endpoint and its fixed public HTTPS origin are configured. It sends a
short-lived signed platform-session binding to that broker and returns only a
one-time `/enrollments/<id>` redirect. The isolated broker owns Steam account
entry, the Steam Guard challenge and Vault ingress; after a successful SteamCMD
login it persists encrypted `config.vdf` through a `SecretRef`. Passwords,
Guard codes and `config.vdf` bytes are never accepted by the Web route.

When the broker or platform-session verification is unavailable, the public
route remains fail-closed (`503`) and does not fabricate an enrollment or a
usable Steam session. The local preview intentionally exercises this state.

`SteamEnrollmentCoordinator` owns the isolated enrollment state machine:
`WAITING_CREDENTIALS → WAITING_STEAM_GUARD → READY`. It binds each enrollment
to tenant, user, platform-session digest, expiry and idempotency digest; clears
password, Guard-code and `config.vdf` buffers after use; and revokes a Vault
write if the database transaction cannot commit. `PostgresSteamEnrollmentStore`
applies tenant RLS and atomically creates the credential metadata, build session
and terminal enrollment record. Migration `005_steam_enrollments.sql` stores no
passwords, Guard codes or `config.vdf` bytes.

The internal `POST /v1/steam/enrollments` adapter accepts only the three-field
platform principal and explicitly rejects extra fields, preventing credentials
from being smuggled through the Web workload. Interactive credential and Guard
entry belong to the broker's separately hosted public UI, not this control
plane route.

The production composition for that boundary starts with `npm run
start:steam-access`. It is a TLS 1.3 mTLS service with disjoint Web and secure-UI
SPIFFE allow-lists. The Web identity can only begin enrollment or reserve a
release challenge. Secure-UI calls additionally require a five-minute Ed25519
capability bound to one enrollment/approval and one action. Password and Guard
requests are `application/octet-stream`, are never parsed as strings or JSON,
and are wiped after the fixed native login connector returns. The service talks
only to fixed HTTPS mTLS origins for interactive Steam login, `config.vdf`
Vault ingress, AAL2 verification and KMS signing. It verifies KMS signatures
locally before persisting metadata and resuming the exact Temporal workflow.
All required mounts and identities are listed in `.access.env.example`.

The browser surface is a separate process started with `npm run
start:steam-secure-ui`; it is not a Next.js route. The external reverse proxy
must keep the platform browser origin unchanged and route only
`/enrollments/*`, `/approvals/*` and `/v1/steam-ui/*` directly to this process.
That preserves the host-only platform session cookies while ensuring password,
Guard and WebAuthn request bodies never pass through the main Web process. Each
request reasserts the live platform session over a dedicated Identity mTLS
identity, validates exact Origin/Sec-Fetch-Site and carries a five-minute
Ed25519 capability bound to the user, session, resource and action. Enrollment
secrets use binary bodies and are cleared on every success or failure path.

For release approval the UI obtains an approval/user-bound WebAuthn challenge
from `POST /v1/steam-release-mfa/challenges`, permits only `required` user
verification and forwards the opaque assertion to the Access Broker. Strict
nonce CSP, no-store, no-referrer, same-origin isolation and WebAuthn permission
headers are applied to every page. `.secure-ui.env.example` lists separate
server, Identity, Access and MFA credentials; the UI session private key exists
only in this process and the Access Broker mounts only its public key.

For the Web deployment, both `DEVILUDO_STEAM_ENROLLMENT_BROKER_URL` and
`DEVILUDO_RELEASE_AUTHORIZATION_BROKER_URL` point at this service's internal
origin. Both public-origin variables point at the shared external platform
origin whose selected paths are reverse-proxied to the isolated UI. The main Web process never receives a password, Guard code, MFA
assertion, `config.vdf`, Vault key or KMS private key.

Release authorization is a separate state machine. The internal Web route can
only reserve an MFA challenge from an authoritative `WAITING_MFA` release
snapshot. The isolated MFA UI completes the challenge under its own HttpOnly
session/Origin/CSRF gate; an injected verifier must return a fresh AAL2 receipt
for the same tenant user. The coordinator then asks Vault/KMS to sign an
authorization bound to the exact release, main SHA and evidence digest,
archives it idempotently, and emits stable `mfa:<approval-id>` to the same
Temporal workflow. A failure after signing resumes from `VERIFIED` without
asking the user to repeat MFA or minting a second authorization.

`PostgresReleaseAuthorizationStore` runs every operation under tenant RLS.
Migration `006_release_authorizations.sql` makes identity and release bindings
immutable and permits only `CREATING → MFA_REQUIRED → VERIFIED → DISPATCHED`
(plus explicit failure/expiry paths). Browser MFA assertion bodies are never
persisted.

`SteamPublisherWorkflowHandler` connects the durable workflow processor to the
two Steam operations. For private Beta it resolves the main SHA, main evidence,
MFA approval and target matrix only from the claimed snapshot and emits the
returned BuildID. For public release it requires all three ordered external
approvals and allows only `SetLive` promotion of that same clean-install-tested
BuildID; a Connector that returns a new or different build is rejected before
the `STEAM_RELEASED` signal is produced.

The production entry is `npm run start:steam-publisher-workflow`. It sends only
the immutable run/main/evidence/MFA bindings or the tested BuildID and three
ordered external approval IDs over TLS 1.3 mTLS to a fixed isolated Steam
Workflow Broker. Only that Broker can materialize the Vault-backed `config.vdf`,
invoke SteamCMD/SteamPipe or access the dedicated build account. Its exact
health identity gates readiness, long uploads heartbeat their workflow lease,
and its receipt must echo every authorization binding. Default publication is
accepted only when `SetLive` returns the same private-Beta BuildID.

The Broker ingress contract is implemented by
`createSteamWorkflowBrokerHandler()` and
`createSteamWorkflowBrokerHttpsServer()`. It requires an allow-listed SPIFFE
workload over TLS 1.3 mutual authentication and binds every POST/GET to the
same tenant header, idempotency key and request digest. Requests, status
variants and receipts use exact-key schemas; unknown fields (including any
credential material), executor identity drift and receipt drift fail closed.
Readiness exposes a fixed semantic version and binary digest that the workflow
client must pin. The irreversible executor remains an injected service behind
this boundary and cannot control the wire schema.

`DurableSteamWorkflowOperationService` writes the exact request to
`steam_workflow_operations` before placing an opaque operation ID on the
isolated executor queue. Migration `020_steam_workflow_operations.sql` binds
the operation to the same tenant/project Agent run under forced RLS, makes its
payload immutable, and permits only fenced `PENDING → RUNNING → terminal`
transitions. `SteamWorkflowOperationWorker` heartbeats a bounded lease and a
stale worker cannot commit after another attempt reclaims it. Retryable
failures release the lease for idempotent redispatch; only bounded terminal
codes are persisted. Neither the HTTP process nor the queue message receives
Steam credentials.

Migration `022_steam_workflow_dispatch.sql` makes that same row a durable
tenant-RLS outbox with an `available_at` retry schedule. The credential-free
production Broker starts with `npm run start:steam-workflow-broker`, reads only
file-mounted TLS material, and never loads a Steam session or Beta password.
`PostgresSteamWorkflowOperationDispatch` polls only `tenantId + operationId`;
the request is re-read and claimed by a fenced Worker transaction. Retryable
executor failures use capped exponential delay, and process loss is recovered
from `PENDING` or an expired `RUNNING` lease rather than an in-memory message.

The isolated executor image starts with `npm run start:steam-workflow-executor`.
It composes an audited, digest-pinned native publisher, tenant-RLS PostgreSQL
authority, checksum-verifying immutable S3 reads and an mTLS Vault/KMS RC
signer with `steamWorkflowWorkerFromEnv()`. Its sorted tenant scope is explicit,
startup probes every dependency before polling, and its logs contain only
bounded lifecycle events. The native adapter has a fixed argv contract, uses
`execFile` without a shell, and rechecks both executable and configuration
digests before every operation. There is intentionally no generic CLI entry
that accepts an arbitrary module path, package URL or shell command. Required
file mounts and fixed identities are documented in
`.workflow-executor.env.example`.

Immediately before execution, `PostgresSteamWorkflowExecutionAuthority`
re-joins the signed RC, non-invalidated main evidence, dispatched MFA
authorization, release state and active App-scoped build session under the
same tenant RLS transaction. Default publication additionally requires the
archived `EXTERNAL_APPROVAL_REQUIRED` Build, its clean-install evidence digest
and the three ordered external approval receipts. The executor rejects any
binding drift before its Steam connector is called, then archives private-Beta
and default-branch receipts idempotently. Migration
`021_steam_release_execution.sql` makes RCs and publication receipts
append-only and enforces tenant/project/run foreign keys. Only Vault SecretRefs
are stored for `config.vdf` and Beta passwords.

RC creation is itself an authoritative pre-upload step. `SteamRcIssuer`
re-resolves the passed `MAIN_RELEASE_GATE` evidence, verifies every immutable
production-export object, fixes a one-hour claim window, delegates Ed25519
signing to a Vault/KMS boundary and persists the exact signed JSON before the
execution authority is read. `PostgresSteamRcIssuanceAuthority` derives object
keys instead of accepting them from a request. Migration
`023_steam_rc_issuance.sql` stores one immutable, tenant-RLS depot configuration
revision and freezes its ID and canonical digest into the append-only RC row.
Retries replay that byte-equivalent artifact; evidence, depot or signature
drift fails before SteamPipe is called.

The control-plane `REQUEST_FRESH_MFA` action now first calls
`PostgresSteamReleasePreparation`. It accepts no App ID, session or branch from
the browser: passed merged-main evidence selects one active immutable project
release revision, which binds the exact build-session SecretRef, Depot revision,
private branch and branch-password SecretRef. Migration
`024_steam_release_preparation.sql` records that workflow/run binding and creates
one idempotent `WAITING_MFA` release with a null approval. The MFA resolver then
requires the same waiting control action. Immediately before RC issuance,
`PostgresSteamPrivateBetaReleasePreparer` verifies the matching authorization is
already `DISPATCHED` and performs the only permitted one-way approval binding to
`STEAM_PRIVATE_BETA`; retries cannot select a newer project configuration.

`npm run start:steam-install-services` mounts two separate TLS 1.3 mTLS
listeners with different client CAs. The preparation listener exposes only
`POST /v1/clean-install-execution-preparations` to Runner Control and accepts
the minimal tenant/project/run/BuildID trigger. It resolves
the passed, non-invalidated main evidence, approved spec/test plan, exact Runner
toolchain and `INSTALL_TESTING` Build receipt again under tenant RLS. The grant
listener exposes only `POST /v1/steam-install-grant-redemptions` to Connector
certificates and independently verifies the signed Runner job plus fresh fleet
manifest. The signed fleet entry must contain a distinct
`steamClientConnectorIdentity`; a Runner's primary certificate is rejected on
this route. Grants expire, are idempotent only for the exact job and may be
redeemed once per target platform. Steam credentials, branch passwords, Guard
data and `config.vdf` never enter either contract. See
`.clean-install.env.example` for file-mounted keys and separate listener ports.

Run the contract tests from the repository root:

```bash
npm run test:steam-publisher
```
