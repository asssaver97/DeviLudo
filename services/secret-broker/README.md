# Secret Broker

`services/secret-broker` is the only production boundary that exchanges opaque
`SecretRef` values for secret bytes. It keeps metadata, fencing state and an
append-only access audit in PostgreSQL while storing bytes only in Vault KV v2.
The public Web, control-plane database, Agent workspace and ordinary logs never
receive a readable Provider credential.

Three disjoint mTLS/SPIFFE roles are enforced:

- control-plane workloads may create or revoke immutable Provider credentials;
- GitHub/Identity workloads may create, take once and destroy OAuth PKCE values,
  or lease only an exact static GitHub OAuth client-secret reference from the
  production allow-list;
- the Inference Gateway may lease a credential for at most five minutes only
  after the Broker re-resolves the active run or Provider probe binding in
  PostgreSQL. It cannot submit an arbitrary Vault path.

Provider writes require a binding-derived idempotency key. Vault creation uses
KV v2 CAS 0, so a retry can replay metadata but cannot overwrite an existing
secret. PKCE reads use a database claim before Vault access and become consumed
before the bytes are returned; the Vault object is then destroyed. Revocation
destroys Vault metadata and leaves only immutable audit information.
An internal fenced sweeper claims expired, unused PKCE records, destroys their
Vault objects and commits an immutable revocation audit. A failed destruction
releases the claim so the next sweep can retry.

## Production startup

Apply `infra/postgres/045_secret_broker.sql`, provision a least-privilege
PostgreSQL role and a Vault policy restricted to the configured KV mount and
`records/` plus approved `static/` paths, then configure the file-mounted values
in `.env.example`.

The Vault token should be a short-lived Vault Agent token. Server keys, client
CA, Vault CA and optional Vault mTLS identity must be mounted as regular files;
the process rejects symlinks and does not accept PEM or tokens in ordinary
environment variables.

```bash
NODE_ENV=production npm run start:secret-broker
```

The listener defaults to port `4762`, requires TLS 1.3 client certificates and
has no plaintext HTTP mode. The service is intentionally absent from the
loopback product demo: local UI tests use isolated in-process fixtures and do
not create real credentials.

## Verification

```bash
npm run test:secret-broker
```

The suite covers immutable/replayed writes, one-time PKCE destruction, run-bound
leases, role separation, fixed Vault paths, CAS creation and secret-free audit
records.
