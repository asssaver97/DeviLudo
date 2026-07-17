# DeviLudo Inference Gateway core

This service boundary authenticates every Claude Code/Codex CLI inference call
with a short-lived `DLRT` run token. It is deliberately fail-closed: creating
the Fastify application without a trusted `GatewayConnector` exposes health and
authorization behavior, but every valid inference request returns
`CONNECTOR_NOT_CONFIGURED` instead of falling back to ordinary `fetch`.

Before a connector can see a request, the gateway verifies:

- HMAC signature, fixed issuer/audience/key id, 15-minute maximum lifetime;
- the complete active run registration: tenant, project, run, profile,
  Provider revision, credential version, nonce, model list and budget;
- route protocol and Agent compatibility (`responses`/Codex or
  `messages`/Claude), active immutable Provider and exact pinned model;
- cumulative cost/input/output usage and the request output-token ceiling;
- public HTTPS endpoint policy and a freshly resolved, public address set.

The authorization result contains only the credential version id. A trusted
connector must resolve that exact version from Vault, connect only to
`endpoint.connectAddresses`, revalidate every redirect and atomically record
usage. No HTTP request may provide an upstream key, Base URL, SecretRef or
alternate Provider.

Run the contract suite from the repository root:

```bash
npm run test:inference-gateway
```
