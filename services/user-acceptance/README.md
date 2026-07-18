# User Acceptance Service

Production-only bridge from authenticated candidate-build feedback to a new
immutable specification iteration. The web workload is authenticated with
mTLS; tenant and actor bindings still come from the platform's signed session
assertion before the request reaches this service.

The service resolves the sole waiting `REQUEST_USER_ACCEPTANCE` action from
PostgreSQL and never accepts candidate, evidence, previous-spec, workflow or
action identifiers from the browser. It calls the isolated low-latency spec
model, atomically commits the next DRAFT `GAME_SPEC`/`TEST_PLAN` pair and a new
dialogue, and only then emits `USER_FEEDBACK`. The control-plane completion
transaction invalidates the exact candidate evidence.

`GENERATING`, `DRAFT_READY` and `COMPLETED` are durable recovery points. Model
failure only expires the generation claim. Completion failure preserves the
new draft and retries delivery without regenerating it.
