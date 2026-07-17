import { pathToFileURL } from "node:url";
import { createControlPlaneApp } from "./bootstrap";

export async function runControlPlane(): Promise<void> {
  const app = await createControlPlaneApp({ logger: ["error", "warn", "log"] });
  const rawPort = process.env.DEVILUDO_CONTROL_PLANE_PORT ?? "4100";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("DEVILUDO_CONTROL_PLANE_PORT is invalid");
  const host = process.env.DEVILUDO_CONTROL_PLANE_HOST ?? "0.0.0.0";
  await app.listen(port, host);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runControlPlane();
}
