import assert from "node:assert/strict";
import test from "node:test";
import { externalRequestHost, requestOriginMatchesHost } from "../lib/web/request-origin";

test("Web validates browser Origin against the public Host instead of its container URL", () => {
  const request = new Request("http://web:3000/api/auth/github/start", {
    headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
  });
  const host = externalRequestHost(request);
  assert.equal(host, "127.0.0.1:3100");
  assert.equal(requestOriginMatchesHost(request.headers.get("origin"), host), true);
  assert.equal(requestOriginMatchesHost("http://127.0.0.1:3000", host), false);
  assert.equal(requestOriginMatchesHost("not a url", host), false);
});
