# External account and membership platform

Identity, workspace membership, Stripe billing and credits are owned by the
private `DeviLudo-Platform` parent repository. This repository contains only a
least-authority client and tenant-scoped projections; it never stores account
service source or Stripe credentials.

Production web workloads set `DEVILUDO_ACCOUNT_API_URL` to the internal HTTPS
account endpoint and obtain `DEVILUDO_INTERNAL_SERVICE_TOKEN` from the secret
broker. Plain HTTP is accepted only when
`DEVILUDO_ACCOUNT_ALLOW_INSECURE_LOCAL=1` inside the local Compose network.

The account assertion derives `tenantId` from the server-side active workspace,
not from browser input. Email-only accounts may enter the product, but GitHub
SCM authorization rejects them until a real GitHub identity is linked.

Migration `065_account_platform_projections.sql` stores only entitlement/event
projections and usage reservation references under the existing forced-RLS
tenant boundary. Account and billing data remain in the separate account
database.

Migration `066_workspace_billing.sql` upgrades those projections to
`TRIAL/PLUS/PRO/PRO_PLUS`, workspace developer/Viewer limits, explicit Credit
units, and immutable Rate Card revision 3. Plus/Pro/Pro+ are $30/$100/$200 per
workspace with 3,000/10,000/20,000 shared monthly Credits and 3/8/15
developers; Stripe quantity is always one. The account authority charges 100
Credits per $1 official model/cloud list cost and keeps supplier cost in a
separate immutable ledger. `lib/billing/account-credits.ts` is the
least-authority integration
used by workflows to reserve, settle, or cancel Credits; it contains no account
implementation, Stripe credential, or cross-tenant database access.

Migration `068_shared_e2e_queue.sql` makes Windows/Linux/macOS capacity a
cross-workspace queue rather than a per-workspace reservation. Release gates,
interactive candidates and background validation receive server-derived,
immutable priority; waiting time prevents starvation and physical Runners rotate
their signed tenant assignment after every completed job. The separate account
authority calculates fixed test-fleet cost from required machine-hours and
productive host-hours for each Credit-usage scenario.

This optimization does not apply to game-requirement conversations.
`spec-dialogue` and `spec-model-broker` have an isolated three-replica minimum,
reserved CPU/memory and low-latency autoscaling so a full E2E backlog cannot
delay user feedback.
