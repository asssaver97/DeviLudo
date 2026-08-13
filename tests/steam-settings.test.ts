import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSteamSecretStore,
  validateSteamBuildToken,
} from "@/services/core/src/steam-settings";

const workspaceId = "60000000-0000-4000-8000-000000000001";

test("workspace Steam credentials are versioned, masked, and isolated from Postgres-facing data", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-secret-"));
  try {
    const store = createSteamSecretStore({
      NODE_ENV: "test",
      DEVILUDO_AGENT_SECRET_ROOT: root,
    });
    const first = await store.writeBuildToken(workspaceId, "steam-token-first");
    const second = await store.writeBuildToken(workspaceId, "steam-token-second");

    assert.match(first.secretRef, new RegExp(`^vault://workspaces/${workspaceId}/steam/build-token/versions/`));
    assert.notEqual(first.secretRef, second.secretRef);
    assert.equal(first.mask.includes("steam-token-first"), false);
    assert.match(first.fingerprint, /^sha256:[0-9a-f]{12}$/);
    assert.equal(await store.readBuildToken(workspaceId, first.secretRef), "steam-token-first");
    assert.equal(await store.readBuildToken(workspaceId, second.secretRef), "steam-token-second");
    assert.equal(await store.readBuildToken("60000000-0000-4000-8000-000000000002", first.secretRef), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Steam build tokens reject whitespace, control characters, and placeholder values", () => {
  assert.equal(validateSteamBuildToken("valid-steam-build-token"), "valid-steam-build-token");
  for (const invalid of ["short", " leading-token", "trailing-token ", "line\nbreak", "null\0byte"]) {
    assert.throws(() => validateSteamBuildToken(invalid), /format is invalid/);
  }
});

test("production refuses to store Steam credentials outside Vault", () => {
  assert.throws(
    () => createSteamSecretStore({ NODE_ENV: "production" }),
    /require Vault/,
  );
});
