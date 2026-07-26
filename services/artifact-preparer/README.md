# Runner input artifact preparer

This isolated service core freezes source-mode Runner inputs before an E2E
attempt can be queued. It is separate from autonomous Agent Workers and from
physical E2E Runners.

`SourceExecutionPreparer` performs one fail-closed sequence:

1. asks an authoritative SCM snapshot port to materialize the exact candidate
   or merged-main commit and return its independently calculated source digest;
2. reads the approved immutable test-plan revision and validates its canonical
   v2 matrix payload, exact digest and pinned Godot version;
3. creates a deterministic Zstandard/USTAR source artifact while rejecting
   links, `.git`, special files, traversal, excess resources and mutation;
4. publishes both content-addressed input objects and verifies exact receipts;
5. only then persists the complete `RunnerExecutionLock` under the workflow
   request digest.

`PostgresSourceExecutionPreparationAuthority` accepts only a minimal workflow
trigger (`tenant/project/run/request digest/mode/commit/matrix`) and then
re-resolves the approved spec, canonical test-plan binding, exact append-only
Runner toolchain revision and authoritative candidate/main source receipt under
tenant RLS. Caller-supplied source or toolchain fields are rejected before the
database is touched.

`PostgresRunnerExecutionLockPort` is the production RLS transaction for step 5.
It uses `SET LOCAL app.tenant_id`, append-only table `runner_execution_locks`
and `(tenant_id, lock_key)` idempotency. A replay is accepted only when the
stored canonical payload has the same digest.

`MtlsPreparedInputObjectClient` is the production boundary for step 4. It
hashes the already materialized file before and after upload, accepts only a
five-minute checksum-bound grant from the Evidence Archive, restricts the
transfer to a sorted HTTPS origin allow-list and requires an independently
verified commit receipt. TLS keys and CAs are read only from absolute mounted
files; the normalized service environment excludes unrelated keys and secrets.

`MtlsAuthoritativeSourceSnapshotClient` now obtains the exact commit/source
tuple from the isolated production `start:source-snapshot` service. That service
resolves append-only GitHub candidate/merge receipts under tenant RLS, uses a
repository-scoped Contents-read installation token, verifies every Git blob,
and returns only a short immutable S3 download grant. `PostgresFrozenTestPlanPort`
independently reads the canonical frozen plan bound to the approved spec.

Run the core contract suite with:

```bash
npm run test:artifact-preparer
```

Run the dedicated production host with `npm run start:artifact-preparer` and
the file-mounted configuration in `.env.example`. The host forces TLS 1.3
client authentication, reloads the short-lived certificate/tenant assignment,
serves only `GET /healthz` and `POST /v1/source-execution-preparations`, and
returns a bounded immutable execution-lock receipt. Runner Control calls this
service before candidate/main scheduling and heartbeats its workflow lease
during long snapshot/build transfers; Steam clean-install uses its separate
publisher-owned lock path. Tests use in-process transports and do not claim
that an external GitHub repository or S3 service was contacted.

## Immutable production image

Build this workload only with `npm run image:build-artifact-preparer`. The
builder accepts a digest-pinned Debian-slim Node 22.15+ base (the minimum line
with the built-in Zstandard stream used by source bundling), an exact 40-byte
source revision, one Linux architecture and the required
`<platform-version>-<sha12>` destination tag. BuildKit must push with maximum
provenance and an SBOM; success emits an immutable receipt bound to the final
registry digest, base image, Dockerfile, lockfile, source and architecture.

`Dockerfile.artifact-preparer` contains no autonomous Agent, Godot executable,
Steam tool or package-install URL. Its non-root fixed entrypoint rejects runtime
arguments, local-test authority, preload/module injection and any work-root
override. TLS material, the signed tenant assignment and database credentials
remain file-mounted/external; `/var/lib/deviludo/artifact-preparer-work` must be
backed by a bounded ephemeral volume and the container root filesystem should
be read-only. The image receipt is a supply-chain artifact, not deployment
authorization; a production scheduler must additionally bind it to live
ConfigMap/Secret identities and an explicit release approval.
