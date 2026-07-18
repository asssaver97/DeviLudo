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

The guest resolves its opaque DLRT reference exactly once over the ephemeral
secret Broker's TLS 1.3 workload boundary. The response is binary, never JSON,
and the request contains only the reference plus the bound run, attempt and
allowed CLI environment variable. The attestation private key path in the
example is a guest-only sealed mount; the Worker host loads only the matching
public key. A deployment may replace that local guest signer with the same
`CandidateArtifactSigner` interface backed by KMS.
