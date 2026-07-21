# Durable delivery workflows

`lib/orchestration/game-delivery.ts` is the deterministic core of the Temporal
workflow. A production worker stores the returned snapshots in Temporal history
and maps `nextCommand()` to activities with retry, heartbeat and cancellation
policies. Long waits—user approval, Provider recovery, MFA, Valve review and
phone confirmation—are signals, not polling loops.

Every signal carries a caller-generated `signalId`. Exact retries are no-ops;
reusing an ID with different content is rejected. External approval signals
also bind the exact current gate, so a delayed Valve-review callback cannot be
mistaken for first-release or default-branch confirmation.

The workflow never resolves a moving Agent default after approval. The control
plane first creates an `AgentRunConfigurationLock`; the workflow receives only
its immutable ID. A Provider outage moves the run to `WAITING_PROVIDER` and a
recovery signal resumes the same locked Agent. A different Profile can only be
selected by a new approved iteration.

A terminal Agent operation is never restarted. `AGENT_FAILED` and candidate
`E2E_FAILED` transition back through `RESOLVING_AGENT_CONFIGURATION`, carrying
an immutable repair binding to the predecessor Run. The configuration service
creates a new Run, inference authorization and resolution digest while cloning
the predecessor's exact Agent/Profile/installation/Provider/model/budget lock.
For E2E failures it also revalidates the non-invalidated failed evidence bundle,
Draft PR, candidate SHA and content-addressed per-platform artifacts, then uses
that candidate—not the original default-branch checkout—as the next workspace
baseline. The source-snapshot and candidate-publication authorities independently
join the predecessor GitHub receipt, so a repair lock cannot name an arbitrary
commit. A Temporal patch marker preserves replay behavior for histories created
before successor repair runs, and delivery projection schema v2 can validate
both history modes.

Activity boundaries are:

1. `startLockedAgentRun` in an ephemeral Linux microVM.
2. `runTargetMatrixE2E` on outbound-mTLS Windows, Linux and macOS runners.
3. `mergeAcceptedDraftPr` through the SCM proxy.
4. `runMainShaReleaseGate` against the actual merge SHA.
5. `uploadSteamPrivateBeta` on the isolated publisher.
6. `installFromCleanSteamClient` and rerun platform E2E.
7. `publishDefaultBranch` only after the ordered Valve review, first-release
   and default-branch confirmation signals.

Accepting the publish activity is not a release result. The workflow remains
open until `STEAM_RELEASED` binds the release ID and the same numeric Steam
BuildID that passed private-Beta clean-client testing.

After the merged-main gate passes, `REQUEST_FRESH_MFA` first creates the
authoritative release record. Its durable worker emits `RELEASE_PREPARED`, so
the read-only delivery projection exposes the exact release ID before the Web
console can open the isolated MFA flow. The state remains `WAITING_MFA` and no
Steam upload command is dispatched until that flow returns `MFA_APPROVED`.
Existing workflow histories that predate this projection signal remain
replay-compatible; their signed MFA authorization is still resolved by the
release authority rather than by browser input.

Every activity is idempotent, takes an idempotency key, and writes an append-only
audit event. E2E activity completions are accepted only through the fencing gate
in `lib/domain/e2e.ts`.
