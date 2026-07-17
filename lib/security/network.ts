export interface EndpointPolicy {
  readonly approvedPorts?: readonly number[];
  readonly maxRedirects?: number;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
  /** Resolver adapters must report every followed CNAME for policy validation. */
  readonly cnameChain?: readonly string[];
  readonly ttlSeconds?: number;
}

export interface DnsResolver {
  /** Called for every connection attempt and every redirect hop. */
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}

export interface ValidatedEndpoint {
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  /** The HTTP connector must connect only to this validated set (DNS pinning). */
  readonly connectAddresses: readonly ResolvedAddress[];
}

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

const NON_PUBLIC_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
];

export function validateProviderBaseUrl(
  raw: string,
  policy: EndpointPolicy = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Provider Base URL is not a valid absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("Provider Base URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Provider Base URL must not contain user information");
  }
  if (url.search) {
    throw new Error("Provider Base URL must not contain query parameters or query secrets");
  }
  if (url.hash) {
    throw new Error("Provider Base URL must not contain a fragment");
  }

  const port = url.port ? Number.parseInt(url.port, 10) : 443;
  const approvedPorts = policy.approvedPorts ?? [443];
  if (!Number.isInteger(port) || !approvedPorts.includes(port)) {
    throw new Error(`Provider port ${String(port)} is not approved`);
  }

  assertPublicHostname(url.hostname);
  return url;
}

export function assertPublicHostname(rawHostname: string): void {
  const hostname = normalizeHostname(rawHostname);
  if (!hostname || hostname.includes("%")) {
    throw new Error("Provider hostname is empty or contains an IPv6 zone identifier");
  }
  if (
    hostname === "localhost" ||
    METADATA_HOSTS.has(hostname) ||
    NON_PUBLIC_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    )
  ) {
    throw new Error(`Provider hostname is local or reserved: ${rawHostname}`);
  }

  if (parseIpv4(hostname) !== null || parseIpv6(hostname) !== null) {
    assertPublicIpAddress(hostname);
  }
}

export function assertPublicIpAddress(address: string): void {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    if (!isPublicIpv4(ipv4)) {
      throw new Error(`Resolved IPv4 address is non-public: ${address}`);
    }
    return;
  }

  const ipv6 = parseIpv6(address);
  if (ipv6 !== null) {
    if (!isPublicIpv6(ipv6)) {
      throw new Error(`Resolved IPv6 address is non-public: ${address}`);
    }
    return;
  }

  throw new Error(`DNS resolver returned an invalid IP address: ${address}`);
}

export async function validateEndpointForConnection(
  raw: string,
  resolver: DnsResolver,
  policy: EndpointPolicy = {},
): Promise<ValidatedEndpoint> {
  const url = validateProviderBaseUrl(raw, policy);
  const hostname = normalizeHostname(url.hostname);
  const literal = parseIpv4(hostname) !== null || parseIpv6(hostname) !== null;
  const addresses = literal
    ? ([
        {
          address: hostname,
          family: parseIpv4(hostname) ? (4 as const) : (6 as const),
        },
      ] satisfies readonly ResolvedAddress[])
    : await resolver.resolve(hostname);

  if (addresses.length === 0) {
    throw new Error("Provider hostname did not resolve to an address");
  }

  for (const answer of addresses) {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new Error("DNS resolver returned an unsupported address family");
    }
    for (const cname of answer.cnameChain ?? []) {
      assertPublicHostname(cname);
    }
    if (
      (answer.family === 4 && parseIpv4(answer.address) === null) ||
      (answer.family === 6 && parseIpv6(answer.address) === null)
    ) {
      throw new Error("DNS resolver address does not match its declared family");
    }
    assertPublicIpAddress(answer.address);
  }

  return Object.freeze({
    url: url.toString(),
    hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 443,
    connectAddresses: Object.freeze(addresses.map((answer) => Object.freeze({ ...answer }))),
  });
}

/**
 * Redirect validation is deliberately a separate operation. Call it for every
 * 3xx response; it re-runs static checks and DNS resolution instead of trusting
 * an earlier answer, which closes redirect-to-private and DNS rebinding paths.
 */
export async function validateRedirectForConnection(
  currentUrl: string,
  location: string,
  redirectIndex: number,
  resolver: DnsResolver,
  policy: EndpointPolicy = {},
): Promise<ValidatedEndpoint> {
  const maxRedirects = policy.maxRedirects ?? 3;
  if (!Number.isInteger(redirectIndex) || redirectIndex < 1 || redirectIndex > maxRedirects) {
    throw new Error("Provider redirect limit exceeded");
  }

  const current = validateProviderBaseUrl(currentUrl, policy);
  const target = new URL(location, current);
  if (target.protocol !== "https:") {
    throw new Error("Provider redirects must not downgrade HTTPS");
  }
  return validateEndpointForConnection(target.toString(), resolver, policy);
}

function normalizeHostname(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function parseIpv4(raw: string): readonly number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPublicIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  if (a === undefined || b === undefined || c === undefined) return false;

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(raw: string): readonly number[] | null {
  let input = normalizeHostname(raw);
  if (!input.includes(":")) return null;

  const dotIndex = input.lastIndexOf(".");
  if (dotIndex >= 0) {
    const colonIndex = input.lastIndexOf(":", dotIndex);
    if (colonIndex < 0) return null;
    const v4 = parseIpv4(input.slice(colonIndex + 1));
    if (!v4) return null;
    const high = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const low = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    input = `${input.slice(0, colonIndex)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const compressionParts = input.split("::");
  if (compressionParts.length > 2) return null;
  const left = splitHextets(compressionParts[0] ?? "");
  const right = splitHextets(compressionParts[1] ?? "");
  if (!left || !right) return null;

  let parts: number[];
  if (compressionParts.length === 1) {
    if (left.length !== 8) return null;
    parts = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    parts = [...left, ...Array<number>(missing).fill(0), ...right];
  }

  return parts;
}

function splitHextets(value: string): number[] | null {
  if (!value) return [];
  const raw = value.split(":");
  const result: number[] = [];
  for (const hextet of raw) {
    if (!/^[0-9a-f]{1,4}$/i.test(hextet)) return null;
    result.push(Number.parseInt(hextet, 16));
  }
  return result;
}

function isPublicIpv6(value: readonly number[]): boolean {
  // IPv4-compatible and IPv4-mapped forms are rejected to avoid parser bypasses.
  if (
    value.slice(0, 6).every((part) => part === 0) ||
    (value.slice(0, 5).every((part) => part === 0) && value[5] === 0xffff)
  ) {
    return false;
  }
  // Public global-unicast space. ULA, link-local, loopback, multicast and
  // unspecified addresses are outside 2000::/3.
  const first = value[0];
  if (first === undefined || first < 0x2000 || first > 0x3fff) return false;
  // Documentation prefix 2001:db8::/32 is non-routable.
  if (first === 0x2001 && value[1] === 0x0db8) return false;
  return true;
}
