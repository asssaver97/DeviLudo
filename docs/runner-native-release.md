# Physical Runner, Godot TestKit and Steam Connector native release

The production E2E host never launches TypeScript from a repository checkout.
Each Windows, Linux and macOS build host creates three self-contained Node 22
single-executable applications (SEA):

- `deviludo-physical-runner[.exe]`
- `deviludo-testkit[.exe]`
- `deviludo-steam-client-connector[.exe]`

The Connector is an independently identified component in the same
Runner-native release envelope. Source-only E2E hosts do not install or start
it. A host may deploy it only when its signed fleet entry declares the separate
Steam Connector SPIFFE identity and its machine capability declares the exact
Connector/bridge lock. No component contains an autonomous Agent.

The build is host-native: the supplied Node binary must be the current host OS
and architecture. Cross-compiling a binary with an unexecuted identity probe is
not accepted. The implementation follows the official [Node.js SEA creation
process](https://nodejs.org/download/release/latest-v22.x/docs/api/single-executable-applications.html),
including the fixed sentinel fuse, the macOS `NODE_SEA` Mach-O segment and
post-injection signing.

## Build an immutable candidate

Use an internally mirrored Node 22 binary and its already-reviewed digest. The
output directory must be absolute, have an existing non-symlink parent and not
already exist:

```bash
NODE_ENV=production npm run build:runner-native -- \
  --node-binary /absolute/toolchain/node \
  --node-binary-digest sha256:<64-lowercase-hex> \
  --output-directory /absolute/staging/runner-native-<platform>-<revision> \
  --source-revision <40-character-git-sha>
```

The builder requires a clean Git tree whose exact `HEAD` equals the supplied
revision. It fixes esbuild `0.28.0` and postject `1.0.0-alpha.6`, validates their
official lockfile source/integrity, records the installed esbuild library and
platform-binary digests, disables SEA snapshot/code-cache portability hazards,
bundles all non-builtin dependencies, uses no shell, and executes each result
with `--identity`. It then atomically publishes the three candidates and
`runner-native-build-receipt.json`. The receipt binds the package lock, Node
binary, injector, source revision, bundle graph and artifact/identity digests.

A build receipt has status `CANDIDATE`. The macOS artifact is only ad-hoc signed
so it can be executed for the identity probe; Windows injection invalidates the
upstream Node signature; Linux is unsigned. None of these states authorizes
installation on a Runner.

## Native signing and release envelope

An isolated release-signing pipeline must consume the candidate bytes and
receipt, then produce final artifacts under the same fixed filenames:

| Target | Required final signature |
| --- | --- |
| macOS | Developer ID signature plus notarization evidence |
| Windows | Authenticode signature |
| Linux | Sigstore bundle plus transparency-log evidence |

For each component it writes
`<component>.signing-evidence.json` with schema
`deviludo.runner-native-signing-evidence.v1`. The record binds the component,
candidate digest, final digest/size and exact native-signature evidence. The
finalizer independently hashes and executes the final artifact before it sends
only canonical public claims to the dedicated Runner-native KMS boundary:

```bash
NODE_ENV=production npm run finalize:runner-native -- \
  --artifacts /absolute/staging/final-artifacts \
  --evidence /absolute/staging/native-signing-evidence \
  --build-receipt /absolute/staging/runner-native-build-receipt.json \
  --release-id <uuid-v4> \
  --published-at <canonical-utc-timestamp> \
  --trust-policy /absolute/policy/runner-native-trust-policy.json \
  --trust-policy-digest sha256:<reviewed-policy-digest> \
  --output /absolute/staging/runner-native-release.json
```

The process reads its fixed KMS origin, key ID and TLS 1.3 client key/certificate/CA
file paths from the five `DEVILUDO_RUNNER_NATIVE_SIGNER_*` variables. It calls
only `/v1/runner-native-releases/sign-ed25519`, uses the release UUID as the
idempotency key, locally verifies the returned signature and writes the envelope
with create-only semantics. An exact valid output is replayed without another
KMS call. The resulting `deviludo.runner-native-release.v2` claims bind the
candidate receipt digest, final artifact digests and sizes, embedded
version/source/platform identity, signature scheme, signer identity and evidence
digests. Runner-native keys are separate from control-plane deployment, job,
Steam RC and Agent supply-chain keys.

Production replaces
[`infra/runner-native-trust-policy.example.json`](../infra/runner-native-trust-policy.example.json)
with a reviewed policy whose exact canonical digest is delivered out of band.
The checked-in key is intentionally `REVOKED` and cannot authorize a release.
Reviewers can compute the semantic digest and inspect key lifecycle metadata
without printing public-key material:

```bash
npm run inspect:runner-native-trust -- \
  --trust-policy /absolute/policy/runner-native-trust-policy.json
```

## Verify before installation

Copy the final artifacts, original candidate receipt, signed release envelope
and reviewed trust policy into a root-owned staging directory on the target
host. Run:

```bash
NODE_ENV=production npm run verify:runner-native -- \
  --artifacts /absolute/staging/final-artifacts \
  --build-receipt /absolute/staging/runner-native-build-receipt.json \
  --release /absolute/staging/runner-native-release.json \
  --trust-policy /absolute/policy/runner-native-trust-policy.json \
  --trust-policy-digest sha256:<reviewed-policy-digest>
```

The verifier rejects unknown fields, symlinks, wrong target OS/architecture,
revoked or out-of-validity keys, policy drift, signature drift, file drift and
embedded identity drift. It invokes only the three fixed artifacts with
`--identity` using `shell: false`, a ten-second timeout and bounded output. A
successful `deviludo.runner-native-install-authorization.v2` receipt is the
input to the privileged, host-specific service installer; it is not itself a
long-lived credential.

The verifier retains read-only support for the former v1 two-component
Runner/TestKit envelope so an already admitted host can be drained safely. New
builds always emit v2 and cannot omit the Connector candidate; no v1 release can
be created by the current builder.

## Plan and stage one host revision

The host does not translate a release envelope into ad-hoc administrator shell
commands. Prepare the target machine JSON and root-owned environment files
first. Every executable path in those files must point into the new release
directory. An upgrade environment also fixes
`DEVILUDO_PHYSICAL_RUNNER_ACTIVATION_GRANT_FILE`; a first enrollment must omit
it because there is no prior Runner identity to drain. Such a plan is marked
`INITIAL_ENROLLMENT`; only a plan with a previous revision is marked
`DRAINED_UPGRADE` and may request an activation grant.

Compile the verified release, machine lock, environment locks and optional
previous plan into one immutable OS-specific plan:

```bash
NODE_ENV=production npm run plan:runner-native-install -- \
  --artifacts /absolute/staging/final-artifacts \
  --build-receipt /absolute/staging/runner-native-build-receipt.json \
  --release /absolute/staging/runner-native-release.json \
  --trust-policy /absolute/policy/runner-native-trust-policy.json \
  --trust-policy-digest sha256:<64-lowercase-hex> \
  --machine-config /etc/deviludo/physical-runner.json \
  --install-root /opt/deviludo/native \
  --runner-env-file /etc/deviludo/physical-runner.env \
  --output /absolute/staging/install-plan.json \
  --previous-plan /opt/deviludo/native/releases/<old-release-id>/install-plan.json
```

Add `--connector-env-file /etc/deviludo/steam-client-connector.env` only on a
Steam-capable machine. A source-only host selects the signed TestKit and Runner
from a v2 release but deliberately omits the Connector. A Steam host selects
all three and independently rehashes the separate UI bridge named by the
Connector environment. The plan emits one fixed SYSTEMD, LAUNCHD or Windows SCM
service identity with no arguments, binds every environment-file digest and
allows no autonomous Agent.

Deliver the canonical `planDigest` out of band, then copy the signed bytes into
a new create-only revision:

```bash
NODE_ENV=production npm run stage:runner-native-install -- \
  --plan /absolute/staging/install-plan.json \
  --plan-digest <64-lowercase-hex>
```

The stager rehashes source and destination, uses exclusive copies, makes every
binary read-only, persists the exact plan and a content-addressed staging
receipt, then atomically renames its private staging directory. An exact retry
replays the receipt; a changed file fails. `STAGED` is not permission to stop a
service or switch a pointer.

Before any privileged host integration is allowed to act, compile the staged
receipt and the still-exact environment locks into one create-only service
transaction:

```bash
NODE_ENV=production npm run compile:runner-native-service-transaction -- \
  --plan /absolute/staging/install-plan.json \
  --plan-digest <64-lowercase-hex> \
  --output /absolute/staging/service-transaction.json
```

On Windows the compiler additionally requires the independently signed SCM
host and its fixed trust input:

```powershell
$env:NODE_ENV = "production"
npm run compile:runner-native-service-transaction -- `
  --plan C:\DeviLudo\staging\install-plan.json `
  --plan-digest <64-lowercase-hex> `
  --output C:\DeviLudo\staging\service-transaction.json `
  --windows-bridge "C:\Program Files\DeviLudo\deviludo-windows-scm-service-bridge.exe" `
  --windows-bridge-manifest C:\DeviLudo\staging\windows-scm-bridge-manifest.json `
  --windows-bridge-trust-policy C:\DeviLudo\policy\windows-scm-bridge-trust-policy.json `
  --windows-bridge-trust-policy-digest <64-lowercase-hex>
```

The compiler re-verifies every staged binary and environment-file digest. It
emits content-addressed systemd units, launchd plists or a Windows SCM
descriptor together with a fixed action enum, manager executable, Connector-
before-Runner start order, reverse stop order and previous-plan rollback
binding. No shell string or caller-supplied argv exists in the transaction.
systemd units enable `NoNewPrivileges`, strict filesystem protection and
dedicated accounts; launchd environment values are XML-escaped.

A Windows transaction deliberately remains `WAITING_NATIVE_BRIDGE` until the
signed `deviludo-windows-scm-service-bridge` contract v1 is present. A Node SEA
console executable is not by itself a Windows Service Control Manager binary.
The bridge source and hardened MSVC build contract live under
`services/runner-control/native`; it hosts only the two fixed DeviLudo services,
rehashes the target while holding a non-replaceable file handle, then launches
without a shell inside a kill-on-close Job Object. The compiler verifies its
Ed25519 manifest, architecture, trust-policy digest and exact PE bytes before
emitting a `READY` transaction. Linux and macOS transactions do not accept
Windows bridge inputs.

The approved Windows builder must compile with MSVC, create SBOM/malware/
vulnerability evidence, apply Authenticode, and finalize the independent
manifest before transaction compilation:

```powershell
$env:NODE_ENV = "production"
npm run finalize:windows-scm-service-bridge -- `
  --architecture x86_64 `
  --binary C:\DeviLudo\release\deviludo-windows-scm-service-bridge.exe `
  --bridge-version 1.0.0 `
  --built-at 2026-07-22T05:00:00.000Z `
  --evidence C:\DeviLudo\release\windows-scm-bridge-evidence.json `
  --output C:\DeviLudo\release\windows-scm-bridge-manifest.json `
  --revision 1 `
  --source-digest <64-lowercase-hex> `
  --trust-policy C:\DeviLudo\policy\windows-scm-bridge-trust-policy.json `
  --trust-policy-digest <64-lowercase-hex>
```

Signer mTLS mounts are listed in
`services/runner-control/.windows-scm-bridge-finalizer.env.example`; the
private Ed25519 key never leaves KMS. The privileged Windows actuator must
rehash both bridge and target, apply the canonical descriptor through Win32
SCM/registry APIs, and write its `renderedDigest` as `DescriptorDigest`.

## Drain, activate, re-register or roll back

For an upgrade, repeatedly request a short-lived activation grant. The output
path must be the same path locked into the target Runner environment:

```bash
NODE_ENV=production npm run request:runner-native-activation -- \
  --plan /absolute/staging/install-plan.json \
  --plan-digest <64-lowercase-hex> \
  --current-plan /opt/deviludo/native/releases/<old-release-id>/install-plan.json \
  --operation-id <uuid-v4> \
  --output /etc/deviludo/runner-native-activation-grant.json
```

The updater uses the current machine certificate over TLS 1.3 mTLS. Ingress
locks the immutable registration row against concurrent lease issuance, moves
it to `DRAINING`, and counts all unexpired `LEASED/RUNNING` rows. While that
count is nonzero the command returns only a drain receipt. At zero it returns a
ten-minute Ed25519 grant binding the current and target identities,
capabilities, release, plan and staging receipt. The host verifies that grant
with its fixed Runner-job public key before allowing its privileged,
platform-specific service manager to atomically install the declarative service
definitions and start the target revision. Floating paths, shell fragments and
in-place binary replacement are outside the plan contract.

The target `deviludo-physical-runner` probes ingress, TestKit and the optional
Steam Connector before advertising readiness. When an activation-grant file is
present it then registers the exact target capability and calls the authenticated
completion operation before entering its lease loop. Ingress marks the old
identity `OFFLINE` only after that registration matches; an unchanged identity
is returned from `DRAINING` to `ONLINE`. Exact completion retries are safe even
after the short grant expires.

If any platform service or readiness probe fails, the privileged host
integration restores the previous service definitions and calls the mTLS
rollback operation with the content-addressed failure evidence. Ingress returns
the old identity to `ONLINE`, quarantines a separately registered target, and
stores an append-only rollback receipt. A different failure digest cannot reuse
the operation. The database operation/grant/rollback ledger is migration `062`.

The installer places artifacts in a revision-addressed read-only directory,
points the OS service definition at `deviludo-physical-runner`, and configures
the existing machine JSON, journal/HMAC, mTLS and signed fleet-policy files.
It installs `deviludo-steam-client-connector` as a separate OS account/service
only on a Steam-capable host; its embedded platform version must equal
`DEVILUDO_STEAM_CONNECTOR_VERSION`, and its mTLS certificate cannot be reused
by the Physical Runner. The platform-specific Steam UI bridge remains a fourth,
separately signed artifact whose exact digest is admitted through the existing
Runner-bound bridge manifest. Its platform evidence and KMS manifest are
finalized by `npm run finalize:steam-native-bridge`; see the
[Connector release contract](../services/steam-client-connector/README.md#bridge-manifest-finalization).
`testKitDigest` and `runnerImageDigest` in the admitted machine capability must
be taken from this verified final release. In-place replacement is forbidden:
install a new revision, drain the host, switch the service pointer, re-register
the capability, then retire the old revision after active leases finish.

Run the build, native signing and verification independently on every selected
Windows/Linux/macOS architecture. A missing platform release leaves that target
offline and therefore keeps the selected E2E matrix closed. Neither binary
contains Claude Code or Codex CLI, and no autonomous Agent may be installed on
an E2E or Steam release host.
