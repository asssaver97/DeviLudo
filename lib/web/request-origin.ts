export function externalRequestHost(request: Request): string {
  return (request.headers.get("host") ?? new URL(request.url).host).trim().toLowerCase();
}

export function requestOriginMatchesHost(origin: string | null, host: string): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
