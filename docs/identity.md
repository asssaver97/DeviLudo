# Invite-only platform identity

`services/identity` is the only authority that turns a one-time invitation and
GitHub public identity into a DeviLudo tenant session. It is independent from
the SCM GitHub App installation Broker: login proves who the user is; the later
installation flow proves which repositories that same numeric GitHub user may
bind.

## Deployment

Run migration `044_invited_platform_identity.sql`, configure the
`DEVILUDO_IDENTITY_*` values documented in `.env.example`, then start
`npm run start:identity`. The listener requires TLS 1.3 client certificates.
`DEVILUDO_IDENTITY_WEB_SPIFFE_IDS` may begin, complete, assert and revoke browser
sessions. A separate `DEVILUDO_IDENTITY_ADMIN_SPIFFE_IDS` allow-list may issue
invitations; neither identity can use the other's endpoint.
The public Web uses `DEVILUDO_IDENTITY_BROKER_URL`; invitation issuance uses the
separate `DEVILUDO_IDENTITY_ADMIN_BROKER_URL`, which must route through an admin
egress connector presenting one of the admin SPIFFE identities. Do not point
both variables at a connector that presents the ordinary Web identity.

The GitHub App callback URL for login is
`https://<console>/api/auth/github/callback`. The existing repository-install
callback remains `https://<console>/api/connections/github/callback`.

## Issuing an invitation

The administrator console exposes `/admin/invitations`. A signed
`PlatformAgentAdmin`/`SecurityAdmin` principal may choose any active tenant and
role. A tenant's authenticated `TenantAdmin` may invite only `ProjectOwner` or
`Auditor` into the same tenant. The link is held only in component memory and is
not written to the control-plane idempotency ledger, browser storage, or audit
payload. The explicit local test site renders this page but returns
`IDENTITY_ADMIN_BROKER_REQUIRED` instead of fabricating a production invite.

An authorized internal administration workload sends this body to
`POST /v1/invitations` over mTLS:

```json
{
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "role": "ProjectOwner",
  "expiresAt": "2032-01-03T00:00:00.000Z",
  "createdBy": "platform-admin"
}
```

The response contains `invitationToken` exactly once. Deliver the user a link
of the form `https://<console>/api/auth/github?invite=<token>` through an
approved secret-sharing channel. The database cannot reconstruct the link.

## Failure and revocation

- Reusing, racing, or replaying an invitation/state is rejected atomically.
- A failed GitHub identity check consumes the PKCE secret but releases an
  otherwise-unexpired invitation.
- A suspended tenant, user or membership invalidates every session on its next
  request.
- `DELETE /api/auth/session` revokes the session digest and clears both browser
  cookies. A copied session cookie is insufficient without its separately bound
  browser cookie.
- Identity service logs must remain disabled or metadata-only; request bodies
  contain one-use credentials.
