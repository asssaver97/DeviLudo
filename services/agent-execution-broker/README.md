# Agent execution Broker

This service is the durable trust boundary between the credential-free Temporal
Agent destination and isolated development Workers.

- `POST /v1/agent-runs` accepts IDs and immutable digests only over mTLS.
- PostgreSQL RLS re-resolves the exact `AgentRun`, Provider projection and
  inference authorization before every claim.
- The Worker receives an expiring `secret://`/Vault reference to a DLRT. The
  token and upstream API key are never stored in PostgreSQL or returned by HTTP.
- Leases prevent a stale microVM attempt from committing a result.
- The microVM can return only a signed candidate artifact. A separate mTLS SCM
  Broker owns GitHub writes; only its archived Draft PR receipt can complete a
  run.
- Completed receipts are bound to the locked image, adapter, Provider, model,
  authoritative candidate commit and Draft PR.
- Provider loss enters `WAITING_PROVIDER`; replay may resume only the same Run.

The Broker process does not install Claude Code or Codex CLI. Polling Worker
composition requires an explicitly supplied isolated executor and ephemeral
secret store, so missing infrastructure fails closed.

`LockedNativeMicrovmAgentExecutor` is the production launcher adapter. It
re-resolves the approved specification and frozen test plan under PostgreSQL
RLS, materializes only the AgentRun's locked GitHub baseline through the
read-only source-snapshot Broker, and invokes one digest-pinned native launcher
with fixed argv and an empty secret-free environment. The guest receives the
internal inference Gateway URL and an opaque expiring SecretRef, never the
third-party Provider URL. A completed response is accepted only when its
candidate artifact has the configured Ed25519 attestation. Start the production
consumer with `npm run start:agent-execution-worker`; it deposits DLRT bytes as
`application/octet-stream` through the configured mTLS ephemeral-secret Broker
and receives only an opaque SecretRef. There is no in-memory production
fallback.

The immutable guest image runs `npm run start:agent-microvm-guest`. Its request
parser rejects extra fields (including Provider Base URLs and credentials),
reconstructs all four exact model roles from the locked Profile, and invokes the
same hardened Claude Code/Codex Adapter supervisor used by the contract suite.
Before execution it independently derives the locked baseline digest using Git
blob and canonical tree rules. After execution it rejects links, Git metadata,
oversized deltas and no-op runs, scans the tree a second time to detect a
surviving background writer, and emits only a bounded Ed25519-attested UPSERT/
DELETE artifact. Source snapshot archives preserve the executable bit so the
guest and GitHub SCM Broker calculate the same final tree digest.

For runs longer than one token lifetime, every DLRT remains capped at 15
minutes. The host renews its fenced database lease while the native launcher is
active and atomically replaces token bytes behind the same SecretRef when five
minutes remain. Authorization expiry or renewal failure aborts the launcher and
enters `WAITING_PROVIDER`; it never stretches a token lifetime.

Claude/Codex receives only a random attempt-local password for a loopback HTTPS
relay. The relay URL must use literal `127.0.0.1`, its certificate has a
matching IP SAN, its CA is baked into the immutable guest trust store, and its
server key is a sealed
guest mount. On every `/v1/messages` or `/v1/responses` request the relay
resolves the current DLRT over the ephemeral-secret Broker's TLS 1.3 workload
boundary, strips local authentication, and forwards with a separate mTLS
Gateway identity. Thus a running CLI can use rotated tokens but never observes
one. The response from the secret Broker is binary, never JSON, and its request
contains only the reference plus the bound run, attempt and allowed CLI
environment variable.

The attestation private key path in the example is also a guest-only sealed
mount; the Worker host loads only the matching public key. A deployment may
replace that local guest signer with the same `CandidateArtifactSigner`
interface backed by KMS.
