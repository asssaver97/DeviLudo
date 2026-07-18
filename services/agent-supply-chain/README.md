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
