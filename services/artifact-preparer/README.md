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

Run the core contract suite with:

```bash
npm run test:artifact-preparer
```

The core intentionally receives SCM snapshot and approved-plan ports. The
Evidence Archive object-publish port is implemented, but production deployment
is not complete until the remaining two ports are wired to separate
mTLS-authenticated GitHub App/spec brokers and an Artifact Preparer host is
started from the workflow path. Tests use in-process transports and do not
claim that an external GitHub repository or S3 service was contacted.
