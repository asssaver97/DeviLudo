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

Production configuration is documented in `.env.example`. This service must be
deployed only to release-signing hosts; it is not installed on Agent workers,
E2E runners, the Web process or the Steam workflow executor.
