# Specification Workflow Bridge

This production service is the durable boundary between an approved immutable
specification and the long-running Temporal delivery workflow.

The first authenticated approval creates two ordered, idempotent events:

1. `SPEC_READY` starts (or verifies) the project workflow and completes its
   `CONTINUE_IDEA_DIALOGUE` action.
2. `SPEC_APPROVED` completes the following `REQUEST_SPEC_APPROVAL` action only
   after PostgreSQL re-resolves the approved spec, frozen test plan and original
   dialogue operation.

After user feedback, Temporal already owns the new draft and is waiting for its
approval. Those later approval operations therefore create only
`SPEC_APPROVED`; they cannot deadlock behind a second initial `SPEC_READY`.

The second signal enters `RESOLVING_AGENT_CONFIGURATION`. A different
`AGENT_CONFIGURATION_SERVICE` workload must materialize and prove the exact
Agent run lock before `RUN_CONFIGURATION_LOCKED` can queue development. The
bridge never selects an Agent, invents a lock, or signals Temporal directly
around the control-plane outbox.

Events and workflow start identities are stored under tenant RLS. Expired
claims are reclaimable, approved events cannot overtake their ready event, and
retries reuse the exact workflow/action/outbox binding.

Run the production service with `npm run start:spec-workflow-bridge` and its
tests with `npm run test:spec-workflow-bridge`.
