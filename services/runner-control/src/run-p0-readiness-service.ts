import { pathToFileURL } from "node:url";
import { createP0ReadinessServer } from "./p0-readiness-http";

export async function runP0ReadinessService(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || String(port) !== String(env.PORT ?? "8080")) {
    throw new Error("P0 readiness port is invalid");
  }
  const server = createP0ReadinessServer(env);
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", accept); });
  process.stderr.write(`${JSON.stringify({ service: "deviludo-p0-runtime-readiness", event: "LISTENING" })}\n`);
  await new Promise<void>((accept) => { const close = () => server.close(() => accept()); process.once("SIGINT", close); process.once("SIGTERM", close); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runP0ReadinessService().catch(() => { process.stderr.write(`${JSON.stringify({ service: "deviludo-p0-runtime-readiness", event: "FAILED" })}\n`); process.exitCode = 1; });
}
