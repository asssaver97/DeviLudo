# Specification model Broker

This production-only service is the missing server side of
`POST /v1/spec-generations`, used by both specification dialogue and user
feedback. It is intentionally not an autonomous Agent: no Claude Code or Codex
CLI is installed, no tools are offered to the model, and it cannot read or
modify repositories.

The deployment pins one exact ACTIVE platform Profile revision and always uses
that Provider's exact `smallFastModel`. A caller supplies only tenant/project/
conversation content and an idempotency key; model, Base URL, protocol,
authentication and credential IDs are resolved from the administrator catalog.
Tenant and project Profiles are rejected at this cross-tenant service boundary.

Before any upstream call, a PostgreSQL tenant-RLS ledger binds the canonical
request to the exact Profile/Provider/credential/model policy. Completed output
is replayed without another charge. A pre-dispatch failure releases the claim;
an expired or post-dispatch ambiguous claim becomes `INDETERMINATE` and is never
silently retried. The ledger stores request/result digests, the strict result,
usage and public configuration only—never prompt history or credential bytes.

The Broker receives a five-minute credential lease from Secret Broker over a
dedicated, disjoint mTLS role. Every upstream connection revalidates HTTPS,
approved ports, DNS/CNAME answers and redirects, pins the validated public IP,
requires TLS 1.3 and allows redirects only within the original origin. Both
OpenAI Responses and Anthropic Messages use their structured JSON output mode;
the returned object is then revalidated against DeviLudo's stricter Godot game
specification contract.

Protocol references: [OpenAI Responses structured output](https://platform.openai.com/docs/api-reference/responses)
and [Claude structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

Apply PostgreSQL migration `055`, add this workload to the Secret Broker
configuration, and start with:

```bash
NODE_ENV=production npm run start:spec-model-broker
```

Use `npm run test:spec-model-broker` for the wire, replay, authority, connector,
SSRF, credential and PostgreSQL contract suite.
