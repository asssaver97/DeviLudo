# DeviLudo Agent Configuration service

This isolated worker consumes only `RESOLVE_AGENT_RUN_CONFIGURATION` waits. For
each approved specification it asks the read-only SCM Broker for an append-only
default-branch source receipt, reads one coherent administrator catalog
revision, resolves `project → tenant → platform`, and inserts the exact
`AgentRun` lock, tenant serving projection and expiring inference authorization
in the same PostgreSQL transaction.

A configured higher-precedence default never silently falls back when it is
invalid. The worker rechecks the active Profile, healthy 100% installation,
approved signed Agent version, fixed model IDs, Provider probes, credential
scope, exact authentication, approved ports, token pricing, governance,
budgets, frozen test plan, Runner toolchain and source receipt before it
signals Temporal. Retries replay the same source operation and resume a locked
run without creating a second run. A pre-existing Provider projection is reused
only when every serving field still matches; drift fails closed before AgentRun
creation.

Run tests from the repository root with `npm run test:agent-configuration` and
start the production worker with `npm run start:agent-configuration`.
