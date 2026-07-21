# Steam external approval monitor

This production-only mTLS boundary closes the ordered external gates after a
private-Beta build has passed clean Steam Client E2E. Only an allow-listed Steam
verification connector may submit an observation; browsers and the Web process
are not trusted approval sources.

The connector submits the exact App ID, tested BuildID, gate, verifier approval
ID, observation timestamp and a SHA-256 digest of its raw Steam evidence. Raw
Steam responses and credentials remain in the connector. The monitor derives
the workflow, release, build, clean-install evidence and expected gate from
PostgreSQL under tenant RLS, rejects stale or future observations, and records
an immutable operation before completing the control-plane action as
`STEAM_APPROVAL_MONITOR`.

Gates are strictly ordered by the release transaction:

1. `VALVE_REVIEW` / `VALVE_REVIEW_APPROVED`
2. `FIRST_RELEASE` / `FIRST_RELEASE_COMPLETED`
3. `DEFAULT_BRANCH_CONFIRMATION` / `DEFAULT_BRANCH_CONFIRMED`

Each completion advances only the current gate and writes an append-only
workflow approval receipt. Replays use the same server-generated signal ID;
late observations cannot satisfy a later gate. Start with:

```bash
npm run start:steam-approval-monitor
```

The service does not simulate Valve review or mobile/SMS confirmation. A
separately deployed, least-privilege Steam verifier must provide the observed
evidence through the configured mTLS identity.
