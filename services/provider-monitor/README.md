# Provider monitor

`provider-monitor` recovers a delivery paused in `WAITING_PROVIDER`. An allow-listed
mTLS scheduler submits only `tenantId`, `projectId`, `actionId` and an idempotency
key. The service derives the immutable Run, Agent, Provider, model roles and
credential version under PostgreSQL RLS; request bodies cannot select or replace
any of them.

The exact Provider is tested through the internal Inference Gateway's full
compatibility and SSRF-safe probe. A successful probe emits one server-generated
`PROVIDER_RESTORED` signal through the workflow outbox. Failed probes leave the
action waiting. Completed checks are replay-safe and the database ledger stores
only a probe digest, never upstream credentials or responses.

An already activated failover is accepted only when it is the project-scoped,
same-Agent fallback frozen in the original configuration lock. This service does
not choose fallbacks and never switches between Claude Code and Codex CLI.
