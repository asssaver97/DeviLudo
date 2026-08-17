import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CodexPromptInput = Readonly<{
  authJson: string;
  model: string;
  prompt: string;
  imageBase64?: string;
  timeoutMs?: number;
}>;

export type CodexPromptRunner = (input: CodexPromptInput) => Promise<string>;

export async function runCodexPrompt(input: CodexPromptInput): Promise<string> {
  validateAuth(input.authJson);
  const root = await mkdtemp(join(tmpdir(), "deviludo-codex-"));
  try {
    await writeFile(join(root, "auth.json"), input.authJson, { mode: 0o600 });
    const args = ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "-m", input.model, "-C", root];
    if (input.imageBase64) {
      const image = join(root, "frame.png");
      await writeFile(image, Buffer.from(input.imageBase64, "base64"), { mode: 0o600 });
      args.push("--image", image);
    }
    args.push("-");
    return await executeCodex(args, input.prompt, root, input.timeoutMs ?? 180_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validateAuth(value: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Codex official login data is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex official login data is invalid");
  }
}

function executeCodex(args: readonly string[], prompt: string, codexHome: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= 8 * 1024 * 1024) stdout.push(Buffer.from(chunk));
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", chunk => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(Buffer.from(chunk));
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Codex CLI failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`));
      const text = extractAgentMessage(Buffer.concat(stdout).toString("utf8"));
      if (!text) return reject(new Error("Codex CLI did not return an Agent message"));
      resolve(text);
    });
    child.stdin.end(prompt);
  });
}

export function extractAgentMessage(output: string): string | null {
  let latest: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
        ? event.item as Record<string, unknown>
        : null;
      if (item?.type === "agent_message" && typeof item.text === "string") latest = item.text;
      else if (event.type === "agent_message" && typeof event.message === "string") latest = event.message;
      else if (typeof event.output_text === "string") latest = event.output_text;
    } catch { /* Codex may emit a bounded non-JSON diagnostic line. */ }
  }
  return latest?.trim() || null;
}
