import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateVisualTestSpec } from "../lib/product/visual-comparison.js";

describe("VisualTestSpec validation", () => {
  it("accepts valid spec with defaults", () => {
    const spec = {
      referenceImage: "screenshots/menu.png",
    };
    assert.ok(validateVisualTestSpec(spec));
  });

  it("accepts valid spec with all fields", () => {
    const spec = {
      referenceImage: "screenshots/menu.png",
      threshold: 0.02,
      captureDelay: 2000,
    };
    assert.ok(validateVisualTestSpec(spec));
  });

  it("rejects any retired version field", () => {
    const spec = {
      version: "2",
      referenceImage: "screenshots/menu.png",
    };
    assert.ok(!validateVisualTestSpec(spec));
  });

  it("rejects missing referenceImage", () => {
    const spec = {};
    assert.ok(!validateVisualTestSpec(spec));
  });

  it("rejects empty referenceImage", () => {
    const spec = {
      referenceImage: "",
    };
    assert.ok(!validateVisualTestSpec(spec));
  });

  it("rejects threshold below 0", () => {
    const spec = {
      referenceImage: "screenshots/menu.png",
      threshold: -0.1,
    };
    assert.ok(!validateVisualTestSpec(spec));
  });

  it("rejects threshold above 1", () => {
    const spec = {
      referenceImage: "screenshots/menu.png",
      threshold: 1.5,
    };
    assert.ok(!validateVisualTestSpec(spec));
  });

  it("rejects negative captureDelay", () => {
    const spec = {
      referenceImage: "screenshots/menu.png",
      captureDelay: -100,
    };
    assert.ok(!validateVisualTestSpec(spec));
  });

  it("accepts threshold at boundaries", () => {
    const spec1 = {
      referenceImage: "screenshots/menu.png",
      threshold: 0,
    };
    assert.ok(validateVisualTestSpec(spec1));

    const spec2 = {
      referenceImage: "screenshots/menu.png",
      threshold: 1,
    };
    assert.ok(validateVisualTestSpec(spec2));
  });

  it("rejects non-object", () => {
    assert.ok(!validateVisualTestSpec(null));
    assert.ok(!validateVisualTestSpec("string"));
    assert.ok(!validateVisualTestSpec(123));
    assert.ok(!validateVisualTestSpec([]));
  });
});
