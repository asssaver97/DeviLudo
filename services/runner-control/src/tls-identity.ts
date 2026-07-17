import { TLSSocket } from "node:tls";
import { assertSha256 } from "../../../lib/domain/types";
import type { TlsRunnerIdentity } from "./contracts";

/**
 * Runner identity is read from the authenticated peer certificate, never from
 * request headers. If TLS terminates in a service mesh, the mesh adapter must
 * provide an equivalently non-forgeable workload-identity channel instead.
 */
export function identityFromTlsSocket(socket: unknown): TlsRunnerIdentity {
  if (!(socket instanceof TLSSocket) || !socket.authorized) {
    throw new Error("Runner ingress requires an authorized mutual-TLS socket");
  }
  const peer = socket.getPeerCertificate(false);
  const fingerprint = normalizeFingerprint(peer.fingerprint256 ?? "");
  assertSha256(fingerprint, "certificateFingerprint");
  const spiffeId = parseSpiffeId(peer.subjectaltname ?? "");
  const certificateNotAfter = new Date(peer.valid_to).toISOString();
  if (!Number.isFinite(Date.parse(certificateNotAfter)) || Date.parse(certificateNotAfter) <= Date.now()) {
    throw new Error("Runner certificate is expired or invalid");
  }
  if (!peer.serialNumber) throw new Error("Runner certificate serial is missing");
  return Object.freeze({
    spiffeId,
    certificateFingerprint: fingerprint,
    certificateSerial: peer.serialNumber.toLowerCase(),
    certificateNotAfter,
  });
}

export function parseSpiffeId(subjectAlternativeName: string): string {
  const values = subjectAlternativeName.split(/,\s*/);
  const uris = values
    .filter((value) => value.startsWith("URI:"))
    .map((value) => value.slice(4));
  const spiffe = uris.filter((value) => value.startsWith("spiffe://"));
  if (spiffe.length !== 1) throw new Error("Runner certificate must contain exactly one SPIFFE URI SAN");
  const url = new URL(spiffe[0]);
  if (url.protocol !== "spiffe:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Runner SPIFFE identity is invalid");
  }
  return url.toString();
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").toLowerCase();
}
