# Agent execution Broker

This service is the durable trust boundary between the credential-free Temporal
Agent destination and isolated development Workers.

- `POST /v1/agent-runs` accepts IDs and immutable digests only over mTLS.
- PostgreSQL RLS re-resolves the exact `AgentRun`, Provider projection and
  inference authorization before every claim.
- PostgreSQL migration 060 and the Broker independently validate the primary
  and fallback AgentVersion receipt digests, exact Adapter interval and built-in
  Adapter before a short-lived token can be issued. Only database-marked
  pre-migration Runs (and runtime-identical repair descendants verified by the
  insert trigger) may retain an explicit null legacy attestation.
- The Worker receives an expiring `secret://`/Vault reference to a DLRT. The
  token and upstream API key are never stored in PostgreSQL or returned by HTTP.
- Leases prevent a stale microVM attempt from committing a result.
- The microVM can return only a signed candidate artifact. A separate mTLS SCM
  Broker owns GitHub writes; only its archived Draft PR receipt can complete a
  run.
- Completed receipts are bound to the locked image, adapter, Provider, model,
  authoritative candidate commit and Draft PR.
- Provider loss enters `WAITING_PROVIDER`; replay may resume only the same Run.
- A terminal failure is repaired only through a new Run. Its work package
  contains the immutable predecessor/evidence binding and bounded artifact
  digests; an E2E repair source snapshot is authorized against the predecessor
  GitHub candidate receipt before the microVM receives it.

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

The native launcher is built from this repository and uses the Firecracker
Jailer with one pre-provisioned network namespace, one ext4 data disk and one
read-only attempt credential disk per attempt. Before the Worker opens PostgreSQL
or any Broker connection it verifies distinct Ed25519 release manifests for the
launcher and SquashFS Guest, including the exact Agent/CLI/Adapter/WorkerImage,
configuration, Firecracker/Jailer, kernel, rootfs and e2fs tool digests. Runtime probing
and every attempt hash the actual files again. Arbitrary VMM argv, shell
templates, `--no-seccomp`, non-Linux hosts and non-root launch are rejected.
Build, scan, signing, namespace and deployment requirements are documented in
[`docs/agent-microvm-launcher.md`](../../docs/agent-microvm-launcher.md).

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
matching IP SAN, its public CA is in the immutable guest trust store, and its
server key exists only on the short-lived read-only credential drive. On every
`/v1/messages` or `/v1/responses` request the relay
resolves the current DLRT over the ephemeral-secret Broker's TLS 1.3 workload
boundary, strips local authentication, and forwards with a separate mTLS
Gateway identity. Thus a running CLI can use rotated tokens but never observes
one. The response from the secret Broker is binary, never JSON, and its request
contains only the reference plus the bound run, attempt and allowed CLI
environment variable.

The attestation private key, relay identity and Gateway/secret-Broker workload
identities are issued as one short-lived ext4 image over a dedicated TLS 1.3
mTLS boundary. The image is bound to the exact tenant/project/run/attempt,
Installation and expiry, is checked for an ext4 superblock and content digest,
is mounted read-only as `/dev/vdc`, and is deleted by the Worker after Jailer
exits. The immutable Guest rootfs contains no private key or CLI session. The
Worker host loads only the matching candidate-attestation public key.
