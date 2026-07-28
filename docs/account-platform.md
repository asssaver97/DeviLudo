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

