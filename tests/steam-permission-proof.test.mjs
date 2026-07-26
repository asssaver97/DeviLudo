import assert from "node:assert/strict";
import test from "node:test";
import { steamLeastPrivilegeProof } from "../lib/connections/steam-permission-proof.ts";

const now = Date.parse("2026-07-26T00:00:00.000Z");
const ready = Object.freeze({
  state: "READY",
  accountName: "deviludo_build_bot",
  allowedAppIds: ["2841930"],
  permissions: ["EditAppMetadata", "PublishAppChanges"],
  verifiedAt: "2026-07-25T23:59:00.000Z",
  expiresAt: "2026-08-26T00:00:00.000Z",
});

test("Steam least-privilege proof accepts only an active exact publishing allow-list", () => {
  assert.deepEqual(steamLeastPrivilegeProof(ready, now), {
    accountName: "deviludo_build_bot",
    allowedAppIds: ["2841930"],
    permissions: ["EditAppMetadata", "PublishAppChanges"],
    verifiedAt: "2026-07-25T23:59:00.000Z",
    expiresAt: "2026-08-26T00:00:00.000Z",
  });

  for (const invalid of [
    { ...ready, state: "WAITING_STEAM_GUARD" },
    { ...ready, allowedAppIds: [] },
    { ...ready, allowedAppIds: ["2841930", "2841930"] },
    { ...ready, permissions: ["EditAppMetadata"] },
    { ...ready, permissions: ["EditAppMetadata", "PublishAppChanges", "ViewFinancials"] },
    { ...ready, expiresAt: "2026-07-26T00:00:00.000Z" },
    { ...ready, verifiedAt: "2026-07-26T00:06:00.000Z" },
  ]) assert.equal(steamLeastPrivilegeProof(invalid, now), null);
});
