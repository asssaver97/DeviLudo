# Specification dialogue service

This service owns the low-latency idea conversation. It is deliberately
separate from Claude Code and Codex CLI: neither development Agent is installed,
and the service cannot run tools or mutate a repository.

Each accepted turn is fenced by `operationKey + expectedRevision`. PostgreSQL
commits the user message, assistant message, complete `GAME_SPEC` draft and
complete `TEST_PLAN` draft in one tenant-RLS transaction. Both revisions are
append-only `immutable_revisions`; the mutable conversation row contains only
the optimistic revision and current pointers.

The model boundary is an isolated mTLS Broker at the exact
`/v1/spec-generations` path. The dialogue service receives no provider API key
or third-party Base URL. The Broker must implement idempotent operation keys and
return the exact strict result schema; malformed, floating Godot/TestKit or
unknown-field output is rejected before persistence.
The production implementation lives in `services/spec-model-broker`; local
development continues to use the visibly identified deterministic sidecar.

The public Web process never calls this service anonymously. Production ingress
requires a client certificate whose SPIFFE ID is listed in
`DEVILUDO_SPEC_DIALOGUE_WEB_SPIFFE_IDS`. The local website instead starts
`services/local-spec-runtime`, a loopback-only deterministic implementation
clearly identified as `deterministic-loopback`.

After the approval transaction commits, the service publishes that exact
draft/approved pair to the fixed mTLS Specification Workflow Bridge. The Bridge
re-resolves the same PostgreSQL authority before accepting it. A failed publish
does not roll back or create a second revision: replaying the same approval
operation returns the committed receipt and republishes the same idempotency
key. No Agent/Profile selection occurs at this boundary.

Approval also resolves the newest project-scoped immutable Runner toolchain
whose exact Godot version and export-template key set match the approved target
matrix. The revision ID and canonical digest are written into
`approved_test_plan_bindings` in the same transaction as the approved/frozen
revision pair. If no compatible revision exists, the entire transaction rolls
back with `RUNNER_TOOLCHAIN_UNAVAILABLE`; no partial approval or moving default
is recorded. Migration `057` repeats the Godot, matrix, digest-field and exact
payload-shape checks in a database trigger so another writer cannot create a
binding that Artifact Preparer would interpret differently.
