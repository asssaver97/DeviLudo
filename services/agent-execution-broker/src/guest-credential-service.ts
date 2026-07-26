import type { EvidenceArchiveWorkloadIdentity } from "../../evidence-archive/src/contracts";
import {
  parseAgentMicrovmCredentialImageRequest,
  type AgentMicrovmCredentialImageRequest,
} from "./guest-credential-contracts";
import type { AgentMicrovmCredentialAuthority } from "./guest-credential-authority-postgres";
import type { GuestCredentialImage, GuestCredentialImageBuilder } from "./guest-credential-image";

export class AgentMicrovmCredentialIssuerService {
  constructor(private readonly options: Readonly<{
    authority: AgentMicrovmCredentialAuthority;
    builder: GuestCredentialImageBuilder;
    attestationKeyId: string;
    now?: () => Date;
  }>) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(options.attestationKeyId)) invalid();
  }

  async issue(identity: EvidenceArchiveWorkloadIdentity, value: unknown): Promise<Readonly<{
    request: AgentMicrovmCredentialImageRequest;
    credentialImage: GuestCredentialImage;
  }>> {
    const request = parseAgentMicrovmCredentialImageRequest(value);
    const issuedAt = validNow((this.options.now ?? (() => new Date()))()).toISOString();
    if (request.attestationKeyId !== this.options.attestationKeyId
      || Date.parse(request.expiresAt) <= Date.parse(issuedAt) + 60_000) invalid();
    const requesterSpiffeId = validIdentity(identity);
    await this.options.authority.authorize(request, issuedAt);
    const credentialImage = await this.options.builder.build(request);
    try {
      await this.options.authority.record({ request, requesterSpiffeId,
        imageDigest: credentialImage.digest, imageSizeBytes: credentialImage.sizeBytes, issuedAt });
      return Object.freeze({ request, credentialImage });
    } catch (error) {
      credentialImage.image.fill(0);
      throw error;
    }
  }

  async probe(): Promise<void> {
    await Promise.all([this.options.authority.probe(), this.options.builder.probe()]);
  }
}

function validIdentity(value: EvidenceArchiveWorkloadIdentity): string {
  if (!value || typeof value !== "object" || typeof value.spiffeId !== "string") invalid();
  try { const url = new URL(value.spiffeId); if (url.protocol !== "spiffe:" || !url.hostname || url.pathname === "/"
      || url.username || url.password || url.search || url.hash || url.toString() !== value.spiffeId) invalid(); }
  catch { invalid(); }
  return value.spiffeId;
}
function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}
function invalid(): never { throw new Error("Agent microVM credential issuance is invalid"); }
