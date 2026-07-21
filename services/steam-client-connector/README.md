# Steam Client Connector

This service is the platform-owned boundary between the Godot TestKit and a
clean Steam Client installation on one physical Windows, Linux or macOS Runner.

It independently verifies the signed Runner job, lease, exact BuildID, target
platform and canonical frozen test plan. Its TLS 1.3 mTLS ingress accepts only
the fixed `/v1/clean-install-executions` contract. Successful native output is
confined to the configured staging root and is re-validated before a
content-bound receipt is returned.

Before invoking the native bridge, the Connector presents a separate mTLS
identity to `/v1/steam-install-grant-redemptions`. The grant service verifies
the same signed job against the fresh fleet manifest and PostgreSQL grant,
then returns an exact lock/platform/AppID/BuildID/branch-bound receipt. A
rejection or receipt mismatch prevents the native Steam session from running.

`SteamClientNativeExecutor` is intentionally an injected port. The native,
signed OS artifact owns the protected Steam session after the Node boundary
has redeemed the opaque install grant; account passwords, Steam Guard answers,
branch passwords and `config.vdf` never cross this Node service contract. The native artifact must
implement `executionId` idempotency and perform a clean client reset before
installing the exact BuildID.

The authenticated health receipt includes the exact Runner ID, target platform,
Connector/bridge versions, controller contract version, native bridge digest,
automation-policy digest and supply-chain evidence digest. Runner Control
derives every expected value from the immutable machine capability lock and
forwards them into the locked TestKit environment; registration fails before
job leasing if any field does not match the live Connector.

The bridge digest is not accepted as an administrator-entered environment
value. Startup verifies an Ed25519-signed `deviludo-steam-native-bridge`
manifest containing the exact Runner, platform, Connector/bridge versions,
controller contract, binary digest, automation-policy digest, build time and
supply-chain evidence digest. The executable is
then hashed again before every probe and execution. Build systems must produce
one signed manifest per Windows/Linux/macOS artifact after platform signing,
malware scanning and notarization where applicable.

Startup mounts a reviewed `deviludo.steam-native-bridge-trust-policy.v1` plus
its canonical SHA-256 digest, not one naked public key. The policy holds sorted
Ed25519 key metadata with `ACTIVE`/`REVOKED` status and validity windows. Policy
drift, a revoked/expired key, or a manifest built outside the key window fails
before the bridge is probed. The checked-in
[`infra/steam-native-bridge-trust-policy.example.json`](../../infra/steam-native-bridge-trust-policy.example.json)
contains only a revoked placeholder.

## Bridge manifest finalization

After the OS-specific pipeline has signed and scanned the Steam UI bridge, it
writes a strict `deviludo.steam-native-bridge-signing-evidence.v1` record with
the platform, final binary digest/size and platform trust evidence: macOS uses
`DEVELOPER_ID_NOTARIZED` plus notarization; Windows uses `AUTHENTICODE`; Linux
uses `SIGSTORE_BUNDLE` plus a transparency-log digest.

The production finalizer rehashes the binary, derives the supply-chain evidence
digest, and asks the dedicated TLS 1.3 mTLS KMS route to sign only canonical
public claims:

```bash
NODE_ENV=production npm run finalize:steam-native-bridge -- \
  --binary /absolute/release/steam-client-bridge \
  --evidence /absolute/release/signing-evidence.json \
  --output /absolute/release/steam-client-bridge-manifest.json \
  --runner-id runner-linux-1 \
  --platform linux \
  --connector-version 0.1.0-beta.1 \
  --bridge-version 1.0.3 \
  --revision 7 \
  --built-at 2026-07-22T00:00:00.000Z \
  --automation-policy-digest <64-lowercase-hex> \
  --trust-policy /absolute/policy/steam-native-bridge-trust-policy.json \
  --trust-policy-digest <64-lowercase-hex>
```

The finalizer reads the five `DEVILUDO_STEAM_NATIVE_BRIDGE_SIGNER_*` settings,
fixes `/v1/steam-native-bridges/sign-ed25519`, uses the claims digest as its
idempotency key, verifies the returned signature locally, and creates the
manifest with no-overwrite semantics. An exact valid output replays without
another KMS call. Inspect a reviewed policy without printing key material via:

```bash
npm run inspect:steam-native-bridge-trust -- \
  --trust-policy /absolute/policy/steam-native-bridge-trust-policy.json
```

The bridge artifact compiles `NativeSteamBridgeController` with one platform
accessibility implementation. The controller fixes the only allowed stage order
to clean-client reset, exact private-build install, production boot and platform
suite. It independently re-verifies the signed Runner job and frozen plan. Both
the bridge and Connector parse the bounded Steam
`steamapps/appmanifest_<appid>.acf`; AppID, BuildID, fully-installed state and
the manifest-derived install directory must all match. The manifest digest is
included in the Connector receipt and checked again by TestKit.

The Node service itself is compiled into
`deviludo-steam-client-connector[.exe]` by `npm run build:runner-native`. Its
embedded identity is included in the same platform-native build receipt and
Ed25519 release envelope as the Physical Runner and TestKit, while installation
remains optional and restricted to fleet entries that declare the separate
Connector SPIFFE identity. Production startup rejects a
`DEVILUDO_STEAM_CONNECTOR_VERSION` that differs from the embedded platform
version. Source checkout/`tsx` startup remains development-only.

This repository tests the service and native adapter contract. It does not ship
Valve credentials or pretend that the local developer machine is an enrolled
Steam build account. Release readiness still requires the verified Connector
release, a separately platform-signed Steam UI bridge and enrolled Steam Client
machines for every selected target platform.

`npm run start:steam-client-connector` starts the source-tree mTLS service for
integration development after
checking the pinned native executable digest and its fixed `probe --json`
contract. See `.env.example`; manifest, policy and executable paths must be
absolute, the policy digest must be delivered out of band, and the configured
platform must match the host OS.
