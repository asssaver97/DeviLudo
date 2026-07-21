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

Delivery cancellation is also authoritative rather than an Agent failure. The
control-plane revocation transaction marks the execution operation `CANCELLED`
and revokes its inference authorization. The execution Broker continues to
project that exact receipt-free terminal state after revocation, never
redispatches it, and the destination connector stops polling without emitting a
synthetic `AGENT_FAILED` receipt. If the native microVM is still running, its
next failed execution-lease heartbeat aborts the process before any candidate
can be accepted. PostgreSQL lease renewal, failure recording and completion all
re-read a lost claim; an exact cancelled job becomes the task processor's
`CANCELLED` result instead of a retry, terminal failure or Worker-health alert.
The cancellation error carries the exact tenant and job binding, so a stale or
cross-job cancellation cannot suppress a real failure.

Provider recovery is issued only by `services/provider-monitor`. Its background
Worker reloads a short-lived signed tenant assignment for every bounded scan;
an allow-listed mTLS scheduler may also identify a tenant, project and waiting
action, but supplies no Provider configuration. Both paths share the canonical
action-derived operation key and durable claim. The monitor re-resolves the Run
and exact effective Provider from PostgreSQL under RLS, rejects active inference
claims and expired authorization, and asks the Inference Gateway to run the full
authentication, model, streaming, tools, cancellation, usage, timeout and
network-safety probe. The workflow completion transaction repeats the
Run/Provider check before it writes the outbox signal, closing the
probe-to-signal race. Failed attempts keep the workflow waiting with bounded
persistent backoff; completed checks replay without probing or signaling again.

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

New workflow histories cap this automatic successor chain at three failed
attempts. The third failure retains its immutable diagnostic/evidence lineage,
clears any stale candidate authority and moves to `WAITING_SPEC_APPROVAL`
instead of resolving a fourth Run. In that state an old approval cannot resume
development. The user-acceptance service must first commit a new DRAFT spec and
test plan descended from the currently approved revision; the control plane
revalidates that draft against the exact exhausted wait before delivering
`USER_FEEDBACK`. The repair context and counter are cleared only after that
signal, and the new revision still requires the normal explicit
`SPEC_APPROVED` gate. A separate Temporal patch marker preserves unbounded
replay for histories created before repair budgets existed.

Failures after merge are a separate human-revision boundary. A failed actual
main-SHA gate emits `MAIN_E2E_FAILED`; a failed clean Steam install emits
`STEAM_INSTALL_FAILED`. Both signals retain the failed evidence and main SHA in
an immutable repair context, but immediately clear the old main, MFA, Steam
BuildID/release and external-approval authority. The workflow enters
`WAITING_SPEC_APPROVAL` and accepts only a distinct `USER_FEEDBACK` draft before
normal approval can resume development from the repository's current main.
These post-merge contexts are rejected by the automatic Agent-configuration
boundary, so they cannot silently consume another model run or bypass user
approval.

For `STEAM_INSTALL_FAILED`, Runner Control returns the workflow receipt only
after one PostgreSQL transaction has written an append-only revocation bound to
the failed attempt, evidence digest, repair prompt, main SHA and Steam BuildID,
then moved both `steam_build_receipts` and `steam_releases` to `FAILED`.
Database guards reject either transition without that exact receipt. Activity
replay may read the terminal release only when the original failed attempt and
operation key match; it cannot schedule a new install against revoked release
authority.

Agent failures persist a bounded, secret-redacted and content-addressed
diagnostic containing the failed runtime stage, exit/timeout classification and
safe messages. The successor configuration service re-resolves that diagnostic
from the authoritative failed receipt. Raw stderr, API keys and workspace data
are never embedded in the workflow signal or repair prompt.

Activity boundaries are:

1. `startLockedAgentRun` in an ephemeral Linux microVM.
2. `runTargetMatrixE2E` on outbound-mTLS Windows, Linux and macOS runners.
3. `mergeAcceptedDraftPr` through the SCM proxy.
4. `runMainShaReleaseGate` against the actual merge SHA.
5. `uploadSteamPrivateBeta` on the isolated publisher.
6. `installFromCleanSteamClient` and rerun platform E2E.
7. `publishDefaultBranch` only after the ordered Valve review, first-release
   and default-branch confirmation signals.

Those three signals are issued only by `services/steam-approval-monitor`. Its
mTLS verifier ingress persists a fresh, content-digested Steam observation,
then independently joins the current waiting action to the exact release,
tested BuildID and passed clean-install evidence under tenant RLS. A delayed or
out-of-order observation therefore cannot complete the next external gate.

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
