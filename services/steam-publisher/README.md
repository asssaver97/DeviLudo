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

The same isolated Broker also mounts
`POST /v1/clean-install-execution-preparations` with
`createSteamCleanInstallPreparationHandler`. The TLS 1.3 mTLS route accepts only
the minimal tenant/project/run/BuildID trigger from Runner Control. It resolves
the passed, non-invalidated main evidence, approved spec/test plan, exact Runner
toolchain and `INSTALL_TESTING` Build receipt again under tenant RLS. An injected
Broker-owned grant issuer returns only an opaque, BuildID/branch/matrix-bound
install grant; Steam credentials, branch passwords, Guard data and `config.vdf`
never enter the execution lock or response. The resulting lock is append-only,
content-addressed and idempotent on the workflow request digest.

Run the contract tests from the repository root:

```bash
npm run test:steam-publisher
```
