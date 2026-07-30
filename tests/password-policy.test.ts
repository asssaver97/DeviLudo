import assert from "node:assert/strict";
import test from "node:test";
import { assertPassword } from "../services/core/src/auth";

test("password policy requires nine characters and any three of four character categories", () => {
  assert.doesNotThrow(() => assertPassword("Abcdefgh9"));
  assert.doesNotThrow(() => assertPassword("Abcdefgh!"));
  assert.doesNotThrow(() => assertPassword("ABCDEFG9!"));
  assert.doesNotThrow(() => assertPassword("abcdefg9!"));

  for (const password of [
    "Abcdefg!",
    "abcdefgh9",
    "ABCDEFGH9",
    "12345678!",
    "Abcdefghi",
  ]) {
    assert.throws(() => assertPassword(password), error => {
      assert.equal((error as { code?: string }).code, "WEAK_PASSWORD");
      return true;
    });
  }
});
