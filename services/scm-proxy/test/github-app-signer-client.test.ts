import assert from "node:assert/strict";
import test from "node:test";
import { MtlsGitHubAppJwtSigner } from "../src/github-app-signer-client";

const signingInput = new TextEncoder().encode(
  `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}`
  + `.${Buffer.from(JSON.stringify({ iss: "778899", iat: 1, exp: 601 })).toString("base64url")}`,
);
const tls = { key: Buffer.alloc(32), certificate: Buffer.alloc(32), ca: Buffer.alloc(32) };

test("GitHub App signer sends only bounded JWT input to a fixed mTLS signing route", async () => {
  let observed: unknown;
  const signer = new MtlsGitHubAppJwtSigner({
    endpoint: "https://vault-signing.internal:8443",
    keyId: "github-app-rsa-v3",
    tls,
    http: async (input) => {
      assert.equal(input.url.href, "https://vault-signing.internal:8443/v1/github-app/sign-rs256");
      observed = JSON.parse(input.body);
      return {
        statusCode: 200,
        payload: {
          schemaVersion: "deviludo.github-app-sign-receipt.v1",
          keyId: "github-app-rsa-v3",
          algorithm: "RS256",
          signature: Buffer.alloc(256, 7).toString("base64url"),
        },
      };
    },
  });
  assert.equal((await signer.signRs256(signingInput)).byteLength, 256);
  assert.deepEqual(observed, {
    schemaVersion: "deviludo.github-app-sign-request.v1",
    keyId: "github-app-rsa-v3",
    algorithm: "RS256",
    signingInput: Buffer.from(signingInput).toString("base64url"),
  });
  assert.equal(JSON.stringify(observed).includes("PRIVATE KEY"), false);
});

test("GitHub App signer rejects alternate endpoints, malformed input and receipt drift", async () => {
  assert.throws(() => new MtlsGitHubAppJwtSigner({ endpoint: "http://localhost:8200", keyId: "github-app-rsa-v3", tls }), /endpoint/);
  const signer = new MtlsGitHubAppJwtSigner({
    endpoint: "https://vault-signing.internal",
    keyId: "github-app-rsa-v3",
    tls,
    http: async () => ({
      statusCode: 200,
      payload: {
        schemaVersion: "deviludo.github-app-sign-receipt.v1",
        keyId: "wrong-key",
        algorithm: "RS256",
        signature: Buffer.alloc(256).toString("base64url"),
      },
    }),
  });
  await assert.rejects(signer.signRs256(signingInput), /receipt/);
  await assert.rejects(signer.signRs256(new TextEncoder().encode("not-a-jwt")), /input/);
});
