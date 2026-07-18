# DeviLudo Agent supply-chain Broker

This isolated service is the only production component allowed to discover and
mirror supported Agent packages, validate signatures and integrity, generate
SBOMs, run malware/vulnerability/sandbox/adapter checks, build one-Agent OCI
WorkerImages, and change new-task rollout percentages.

The TypeScript Broker does not run administrator commands or package URLs. It
accepts four versioned mTLS requests from the control plane, persists their
immutable binding in PostgreSQL, and invokes one signed native artifact through
fixed argv and immutable request/response files. The native policy file pins the
official sources, trust roots, scanners, internal registry and development
Worker pools. It must not contain tenant source code or upstream inference keys.

Production requires file-mounted TLS material, exact server/native/config
SHA-256 values, a sorted SPIFFE allow-list and TLS PostgreSQL. CLI self-update is
disabled, and E2E/Steam nodes are outside this service's deployment authority.

## Terminal policy failures

The pinned native executable exits with code `42` only when it has written a
complete `deviludo.agent-supply-chain-terminal-failure.v1` receipt. The receipt
binds the operation key, request digest, operation kind, allow-listed failure
code, evidence digest and timestamp. Validation failures are `REJECTED`;
build/rollout failures are `QUARANTINED`. Any other exit, missing/tampered
receipt, output on stdout/stderr, timeout, database error or network error is a
transient service failure and cannot change a catalog security state.

The Broker durably completes and replays terminal receipts, so retries cannot
rerun a rejected binary or canary. The control plane stops new-task rollout,
keeps running tasks on their locked image, and atomically restores effective
defaults to an active Profile on the last healthy installation when one exists.
