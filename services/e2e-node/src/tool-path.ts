import { delimiter, isAbsolute } from "node:path";

export function e2eToolPath(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DEVILUDO_E2E_TOOL_PATH
    ?? (process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/bin:/usr/bin:/bin");
  const entries = value.split(delimiter).filter(Boolean);
  if (entries.length < 1 || entries.length > 20 || entries.some(entry => !isAbsolute(entry) || /[\r\n]/.test(entry))) {
    throw new Error("DEVILUDO_E2E_TOOL_PATH must contain only absolute directories");
  }
  return entries.join(delimiter);
}

export function e2eExecutableInvocation(
  executable: string,
  arguments_: readonly string[],
  nodeExecutable = process.execPath,
): Readonly<{ executable: string; arguments: readonly string[] }> {
  return executable.endsWith(".mjs")
    ? Object.freeze({ executable: nodeExecutable, arguments: Object.freeze([executable, ...arguments_]) })
    : Object.freeze({ executable, arguments: Object.freeze([...arguments_]) });
}
