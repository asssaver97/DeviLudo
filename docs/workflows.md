# Durable delivery workflows

`lib/orchestration/game-delivery.ts` is the deterministic core of the Temporal
workflow. A production worker stores the returned snapshots in Temporal history
and maps `nextCommand()` to activities with retry, heartbeat and cancellation
policies. Long waits—user approval, Provider recovery, MFA, Valve review and
phone confirmation—are signals, not polling loops.

The workflow never resolves a moving Agent default after approval. The control
plane first creates an `AgentRunConfigurationLock`; the workflow receives only
its immutable ID. A Provider outage moves the run to `WAITING_PROVIDER` and a
recovery signal resumes the same locked Agent. A different Profile can only be
selected by a new approved iteration.

Activity boundaries are:

1. `startLockedAgentRun` in an ephemeral Linux microVM.
2. `runTargetMatrixE2E` on outbound-mTLS Windows, Linux and macOS runners.
3. `mergeAcceptedDraftPr` through the SCM proxy.
4. `runMainShaReleaseGate` against the actual merge SHA.
5. `uploadSteamPrivateBeta` on the isolated publisher.
6. `installFromCleanSteamClient` and rerun platform E2E.
7. `publishDefaultBranch` only after external approval signals.

Every activity is idempotent, takes an idempotency key, and writes an append-only
audit event. E2E activity completions are accepted only through the fencing gate
in `lib/domain/e2e.ts`.
