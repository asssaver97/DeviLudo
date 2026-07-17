import { json } from "@/lib/control-plane/http";

export async function POST() {
  return json({
    error: {
      code: "STEAM_PUBLISH_DISPATCH_REQUIRED",
      message: "Accept and publish requires the production MFA signer, Steam publisher and authoritative evidence dispatcher.",
      details: { storesPrimaryPassword: false, acceptsHeaderMfaProof: false, acceptsClientEvidenceStatus: false },
    },
  }, { status: 503 });
}
