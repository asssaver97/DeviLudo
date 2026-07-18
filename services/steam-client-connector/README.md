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
Connector version and native bridge digest. Runner Control derives the expected
values from the immutable machine capability lock and forwards them into the
locked TestKit environment; registration fails before job leasing if any field
does not match the live Connector.

This repository tests the service and native adapter contract. It does not ship
Valve credentials or pretend that the local developer machine is an enrolled
Steam build account. Release readiness still requires signed native artifacts
and enrolled Steam Client machines for every selected target platform.

`npm run start:steam-client-connector` starts the production mTLS service after
checking the pinned native executable digest and its fixed `probe --json`
contract. See `.env.example`; all paths must be absolute, and the configured
platform must match the host OS.
