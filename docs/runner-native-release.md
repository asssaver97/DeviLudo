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

The installer places artifacts in a revision-addressed read-only directory,
points the OS service definition at `deviludo-physical-runner`, and configures
the existing machine JSON, journal/HMAC, mTLS and signed fleet-policy files.
It installs `deviludo-steam-client-connector` as a separate OS account/service
only on a Steam-capable host; its embedded platform version must equal
`DEVILUDO_STEAM_CONNECTOR_VERSION`, and its mTLS certificate cannot be reused
by the Physical Runner. The platform-specific Steam UI bridge remains a fourth,
separately signed artifact whose exact digest is admitted through the existing
Runner-bound bridge manifest.
`testKitDigest` and `runnerImageDigest` in the admitted machine capability must
be taken from this verified final release. In-place replacement is forbidden:
install a new revision, drain the host, switch the service pointer, re-register
the capability, then retire the old revision after active leases finish.

Run the build, native signing and verification independently on every selected
Windows/Linux/macOS architecture. A missing platform release leaves that target
offline and therefore keeps the selected E2E matrix closed. Neither binary
contains Claude Code or Codex CLI, and no autonomous Agent may be installed on
an E2E or Steam release host.
