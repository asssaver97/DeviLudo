/**
 * Local fixture APIs are deliberately unreachable unless the process was
 * started by the explicit local test launcher. A loopback-looking Host header
 * is not an authorization boundary and therefore is never sufficient alone.
 */
export function isLoopbackTestRequest(
  request: Request,
  environment?: Readonly<Record<string, string | undefined>>,
): boolean {
  // Keep the default properties explicit so Vinext can replace the small,
  // allow-listed values in its Cloudflare Worker build. Do not expose the
  // whole Node process.env object to application code.
  const nodeEnvironment = environment ? environment.NODE_ENV : process.env.NODE_ENV;
  const localTestMode = environment ? environment.DEVILUDO_LOCAL_TEST_MODE : process.env.DEVILUDO_LOCAL_TEST_MODE;
  if (nodeEnvironment === "production" || localTestMode !== "1") {
    return false;
  }

  try {
    const url = new URL(request.url);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function assertLoopbackTestRequest(request: Request, message: string): void {
  if (!isLoopbackTestRequest(request)) throw new Error(message);
}
