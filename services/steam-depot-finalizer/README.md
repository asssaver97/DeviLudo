# Steam Depot Finalizer

This production-only service is the credential-isolated boundary that turns a
Runner `production-export` into the exact signed depot referenced by Steam RC
v2. Its public contract contains content addresses only; Steam passwords,
certificate bytes, private keys, Apple credentials and Sigstore tokens are
forbidden from request, receipt, PostgreSQL and process output.

The TLS 1.3 server accepts only the allow-listed Steam workflow executor at
`POST /v1/steam-depots/finalize`. Each request is bound to tenant, project,
release, main SHA, evidence bundle, target platform and raw Runner export. A
tenant-RLS operation ledger fences retries and replays the same receipt after a
process or network interruption.

Each deployment is bound by `DEVILUDO_STEAM_DEPOT_FINALIZER_PLATFORM` to exactly
one native OS and advertises only that platform's signing scheme. Windows,
Linux and macOS therefore run as three distinct release-signing services with
different DNS names and host credentials. The Steam Workflow Executor requires
all three distinct mTLS endpoints at startup and routes each depot by its frozen
target platform; no node or load balancer may claim capabilities it cannot
execute locally.

`LockedNativeSteamDepotFinalizer` verifies the exact executable and policy file
digests, uses a fixed `finalize --policy-file ... --request-file ...
--receipt-file ...` argv without a shell, and supplies a minimal environment.
The controller obtains signing authority only from the host keystore/HSM named
by the immutable policy:

- Windows: Authenticode and a timestamped verification receipt.
- Linux: Sigstore identity/signature/transparency evidence.
- macOS: Developer ID signing plus mandatory accepted notarization evidence.

The controller must upload the signed artifact and public evidence to the
deterministic content-addressed object keys in its receipt. The Steam workflow
executor independently checks all objects in S3 before it signs RC v2, so a
controller receipt alone never authorizes SteamPipe.

## Native controller core

`NativeSteamDepotController` is the shared, platform-independent core used by
the separately released native executable. It accepts only the deterministic
Godot TestKit `production-export.tar` format, verifies the requested source
digest, tar checksum, exact manifest and every file digest, and reconstructs
the export below a fresh `0700` work directory without links or traversal.

The selected signer is fixed to one host platform and one scheme. Windows
signs `DeviLudo.exe`, Linux signs `DeviLudo.x86_64`, and macOS signs the unique
`DeviLudo.app` after making only the selected executable owner-writable.
After the native tool returns, the controller walks the complete result again,
rejects links, devices, hard links, path escapes, missing source files and size
or count overflow, and includes signer-created files such as macOS
`_CodeSignature/CodeResources` in a new deterministic package.

Signing and notarization evidence must be secret-free JSON bound to the exact
request digest, platform and signing scheme. The finalized package and evidence
are written only to deterministic, content-addressed object keys; the returned
receipt is validated against the original request before it crosses the mTLS
service boundary. Tests run the same controller contract for Windows, Linux
and macOS and prove digest drift and manifest traversal stop before signing.

`run-native-controller.ts` implements the exact child-process CLI accepted by
`LockedNativeSteamDepotFinalizer`. Its canonical, immutable policy selects one
platform, fixed tool paths/digests/versions, host keystore or KMS identity,
content-addressed S3 bucket and file-mounted S3 secret/CA. The CLI rejects
additional arguments, cross-platform requests, non-canonical policy bytes and
request/receipt files outside the parent-created working directory.

The controller is not executed from TypeScript source in production.
`npm run build:steam-depot-finalizer-native --` builds one host-native Node SEA
candidate from the exact clean commit and a digest-pinned Node 22 runtime. The
receipt binds the target OS/architecture, Node, esbuild, postject, package lock,
complete bundle input count, embedded `--identity` document and candidate
digest. Windows and macOS candidates deliberately record that their upstream
Node signature was invalidated or replaced by build-only ad-hoc signing.

After platform code signing and SBOM/malware/vulnerability/provenance checks,
`npm run finalize:steam-depot-finalizer-native --` accepts only a `PASS`
evidence document bound to both candidate and released bytes. Its dedicated
TLS 1.3 mTLS KMS route is
`/v1/steam-depot-finalizer-native-releases/sign-ed25519`; this release key and
trust policy are independent from the service bundle, Runner and Steam
Workflow Executor. Inspect a proposed policy with
`npm run inspect:steam-depot-finalizer-native-trust --`. The checked-in example
is intentionally revoked.

Before PostgreSQL, the public mTLS listener, policy parsing or a signing probe
can start, the service verifies both signed release chains. It hashes the
native binary and build receipt through `O_NOFOLLOW` handles, verifies the
native release envelope, then executes only `--identity` in an empty production
environment and binds its embedded version, source commit, Node version,
platform and architecture to the release claims.

`createSteamDepotFinalizerHostInstallPlan` composes the independently verified
service and controller authorizations into one immutable per-host plan. The
plan copies both artifacts, both build receipts, both signed release envelopes,
both trust policies, the native policy and the reference-only environment lock
into one release directory. That tree is root-owned and read-only; only the
separate work root is writable by the service account. The generated service
definition uses a dedicated non-interactive systemd, launchd or Windows SCM
identity, fixes the Node runtime digest, forbids Agent installation, credential
export and automatic updates, and requires an explicit egress allow-list.
Upgrades must first drain the durable operation ledger to zero and retain the
previous plan/release digests for automatic rollback after a failed signed
release, identity, native probe or mTLS readiness check.

`LockedSteamDepotPlatformSigner` invokes only fixed no-shell argv. Windows uses
`signtool sign` plus `verify` and a fixed HTTPS timestamp authority; Linux uses
`cosign sign-blob` plus `verify-blob`, a fixed KMS reference, public-key digest
and transparency bundle; macOS uses `codesign`, `notarytool`, `stapler` and
`spctl` with a fixed Developer ID and Keychain profile. Tool binaries are
re-hashed before every probe and operation. The dedicated S3 adapter requires
TLS 1.3, SigV4, server checksum metadata and conditional immutable writes, and
byte-verifies an existing object before accepting a replay.

Production configuration is documented in `.env.example`. This service must be
deployed only to release-signing hosts; it is not installed on Agent workers,
E2E runners, the Web process or the Steam workflow executor.

## Restricted host installation

The production host chain is deliberately split into four create-only steps:
`plan:steam-depot-finalizer-host-install` verifies both signed releases, their
build receipts, the canonical native policy, the embedded SEA identity and the
fixed Node runtime; `stage:steam-depot-finalizer-host-install` copies the ten
locked inputs through `O_NOFOLLOW` descriptors into a root-owned read-only
release directory; `compile:steam-depot-finalizer-host-transaction` renders a
hardened systemd, launchd or restricted SCM definition; and
`apply:steam-depot-finalizer-host-transaction` accepts only a short-lived
Ed25519 activation grant bound to the exact plan, staging receipt, transaction,
definition and output receipt path.

Linux and macOS activation re-hash every staged file and the Node runtime before
mutation, journal the previous definition, switch it atomically, and require the
signed service/native releases, embedded native identity, live native S3/signing
probe and a real TLS 1.3 mTLS `/healthz` request to pass. A failed gate restores
the previous definition (or removes an initial definition) and emits an
immutable rollback receipt. Interrupted activation is recovered from the same
journal, and a completed receipt replays without touching the service. Upgrades
require a signed `DRAINING` state with zero active finalization operations.

Windows transactions remain non-runnable until independently signed SCM bridge
and native actuator authorizations are attached. The POSIX actuator explicitly
refuses Windows; it never falls back to PowerShell, `sc.exe`, a shell command or
an Agent runtime.

## Service release chain

Production does not execute this service from the repository. Build the exact
reviewed commit with `npm run build:steam-depot-finalizer-service --` and an
absolute, not-yet-existing output directory. The build fails on a dirty tree,
pins esbuild 0.28.0 and records the package lock, complete bundle input set and
artifact digest in an immutable receipt.

After SBOM, malware, vulnerability and provenance checks have produced a
`PASS` evidence document, run
`npm run finalize:steam-depot-finalizer-service --` in the offline release
environment. The finalizer calls only the TLS 1.3 mTLS KMS route
`/v1/steam-depot-finalizer-service-releases/sign-ed25519`. The runtime trust
policy is independent from Runner, Agent and Steam Workflow Executor release
keys; the checked-in example is intentionally revoked. Review a proposed
policy without printing public-key material with
`npm run inspect:steam-depot-finalizer-service-trust --`.

The signed bundle must be launched directly with Node and the exact artifact,
build receipt, release envelope and trust policy paths/digests from
`.env.example`. Before opening PostgreSQL, loading its TLS listener or probing
the signing controller, the process verifies that `process.argv[1]` is that
artifact, hashes it through an `O_NOFOLLOW` handle and verifies the Ed25519
release against the fixed platform version. Source-tree startup is reserved
for non-production local tests with `DEVILUDO_LOCAL_TEST_MODE=1`.
