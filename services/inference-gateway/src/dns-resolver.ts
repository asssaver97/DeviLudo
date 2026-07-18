import { Resolver } from "node:dns/promises";
import type { DnsResolver, ResolvedAddress } from "../../../lib/security/network";

const MAX_CNAME_DEPTH = 8;

/** System DNS adapter that reports and bounds the complete followed CNAME chain. */
export class NodeGatewayDnsResolver implements DnsResolver {
  constructor(private readonly resolver = new Resolver()) {}

  async resolve(hostname: string): Promise<readonly ResolvedAddress[]> {
    const chain: string[] = [];
    let current = hostname;
    for (let depth = 0; depth < MAX_CNAME_DEPTH; depth += 1) {
      const aliases = await this.#cname(current);
      if (aliases.length === 0) break;
      if (aliases.length !== 1) throw new Error("Provider DNS returned an ambiguous CNAME chain");
      const next = aliases[0]!.toLowerCase().replace(/\.$/, "");
      if (!next || next === current || chain.includes(next)) throw new Error("Provider DNS CNAME chain is invalid");
      chain.push(next);
      current = next;
      if (depth === MAX_CNAME_DEPTH - 1) throw new Error("Provider DNS CNAME chain exceeded its bound");
    }
    const [ipv4, ipv6] = await Promise.all([this.#ipv4(current), this.#ipv6(current)]);
    const addresses: ResolvedAddress[] = [
      ...ipv4.map((answer) => Object.freeze({ address: answer.address, family: 4 as const, cnameChain: Object.freeze([...chain]), ttlSeconds: answer.ttl })),
      ...ipv6.map((answer) => Object.freeze({ address: answer.address, family: 6 as const, cnameChain: Object.freeze([...chain]), ttlSeconds: answer.ttl })),
    ];
    if (addresses.length === 0) throw new Error("Provider DNS returned no address records");
    return Object.freeze(addresses);
  }

  async #cname(hostname: string): Promise<readonly string[]> {
    try { return await this.resolver.resolveCname(hostname); }
    catch (error) { if (notFound(error)) return []; throw error; }
  }
  async #ipv4(hostname: string): Promise<readonly { address: string; ttl: number }[]> {
    try { return await this.resolver.resolve4(hostname, { ttl: true }); }
    catch (error) { if (notFound(error)) return []; throw error; }
  }
  async #ipv6(hostname: string): Promise<readonly { address: string; ttl: number }[]> {
    try { return await this.resolver.resolve6(hostname, { ttl: true }); }
    catch (error) { if (notFound(error)) return []; throw error; }
  }
}

function notFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENODATA" || code === "ENOTFOUND";
}
