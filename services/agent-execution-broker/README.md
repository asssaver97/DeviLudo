# Agent execution Broker

This service is the durable trust boundary between the credential-free Temporal
Agent destination and isolated development Workers.

- `POST /v1/agent-runs` accepts IDs and immutable digests only over mTLS.
- PostgreSQL RLS re-resolves the exact `AgentRun`, Provider projection and
  inference authorization before every claim.
- The Worker receives an expiring `secret://`/Vault reference to a DLRT. The
  token and upstream API key are never stored in PostgreSQL or returned by HTTP.
- Leases prevent a stale microVM attempt from committing a result.
- Completed receipts are bound to the locked image, adapter, Provider, model,
  candidate commit and Draft PR.
- Provider loss enters `WAITING_PROVIDER`; replay may resume only the same Run.

The Broker process does not install Claude Code or Codex CLI. Polling Worker
composition requires an explicitly supplied isolated executor and ephemeral
secret store, so missing infrastructure fails closed.
