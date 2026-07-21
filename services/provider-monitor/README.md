# Provider monitor

`provider-monitor` automatically recovers a delivery paused in
`WAITING_PROVIDER`. Its background Worker reloads and verifies a short-lived,
control-plane-signed tenant assignment on every cycle, then performs a bounded
RLS-scoped scan. It never discovers tenants with an owner-role database query.
An allow-listed mTLS scheduler can also request an immediate check using only
`tenantId`, `projectId`, `actionId` and the server-defined operation key. The
service derives the immutable Run, Agent, Provider, model roles and credential
version under PostgreSQL RLS; request bodies cannot select or replace any of
them.

The exact Provider is tested through the internal Inference Gateway's full
compatibility and SSRF-safe probe. A successful probe emits one server-generated
`PROVIDER_RESTORED` signal through the workflow outbox. Failed probes leave the
action waiting and schedule bounded exponential backoff in the same durable
ledger. Automatic and mTLS-triggered attempts share one action-derived operation
key, claim and receipt, so a crash or concurrent scheduler cannot duplicate the
workflow signal. The ledger stores only a probe digest and safe failure code,
never upstream credentials or responses.

An already activated failover is accepted only when it is the project-scoped,
same-Agent fallback frozen in the original configuration lock. This service does
not choose fallbacks and never switches between Claude Code and Codex CLI.
