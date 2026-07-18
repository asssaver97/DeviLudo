# Evidence archive service

This is the isolated content-addressed storage boundary used by the physical
Runner ingress and platform-owned TestKit. It contains no Agent and exposes
only four client-certificate-authenticated routes:

- `GET /healthz`
- `POST /v1/runner-evidence`
- `POST /v1/runner-artifact-grants`
- `POST /v1/runner-artifact-commits`

Health and final bundle submission are restricted to the sorted Runner-ingress
SPIFFE allow-list. Artifact routes instead verify the complete Ed25519 Runner
job and reload the short-lived signed fleet manifest on every request, binding
the certificate SPIFFE ID, fingerprint, Runner ID, platform, capability digest
and tenant assignment. A request cannot use a job issued to another machine.

Input grants can download only the source object and digest already present in
the signed job. Evidence upload keys are derived server-side from tenant,
project, attempt, platform, category and digest. Grants last at most five
minutes and never reveal S3 credentials. Uploads require an exact byte length,
content type, `If-None-Match: *`, metadata digest and S3 checksum. A separate
commit request performs an authenticated S3 `HEAD` and checks server checksum,
metadata and size. One immutable reservation per attempt/platform/category
prevents a retry from substituting a different object.

The archive revalidates every UUID, digest, target-matrix member, platform manifest,
derived status, timestamp and canonical bundle digest before writing anything.
In production it also verifies that all six referenced top-level evidence
objects exist at their derived keys before accepting the final bundle.
The object key is derived server-side as
`tenants/<tenant>/projects/<project>/evidence/<bundle-digest>.json`; a request
cannot choose a bucket or key.

Production uses the built-in path-style S3 client. It requires HTTPS with a
pinned CA, loads access and secret keys from files, uses AWS Signature V4, sends
`If-None-Match: *`, follows no redirects and never overwrites an existing key.
On an idempotent retry it downloads the existing bounded object and verifies
its bytes, length, metadata and SHA-256 before returning the same receipt.

Failed matrices also create a deterministic immutable repair prompt containing
only content-addressed failed-platform references. Passing bundles never receive
a repair prompt. The filesystem backend uses atomic no-replace hard-link
creation and is rejected when `NODE_ENV=production`.

Start the service with:

```bash
npm run start:evidence-archive
```

See `.env.example` for the required mTLS and S3 mounts.
