# Evidence archive service

This is the isolated content-addressed storage boundary used by the physical
Runner ingress. It contains no Agent and exposes only two client-certificate
authenticated routes:

- `GET /healthz`
- `POST /v1/runner-evidence`

The caller SPIFFE ID must be present in the sorted deployment allow-list. The
archive revalidates every UUID, digest, target-matrix member, platform manifest,
derived status, timestamp and canonical bundle digest before writing anything.
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
