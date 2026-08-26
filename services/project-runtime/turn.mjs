#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// Source changes must remain writable by the trusted Core project group so
// server-side checkpointing and generated-asset retirement stay possible.
process.umask(0o002);

const request = JSON.parse((await readStdin()).toString("utf8"));
validateRequest(request);
const stateRoot = process.env.DEVILUDO_RUNTIME_STATE_ROOT ?? "/var/lib/deviludo-runtime";
const sessionFile = `${stateRoot}/sessions/${request.role.toLowerCase()}.json`;
const skillFile = `/opt/deviludo/skills/${request.role.toLowerCase()}/SKILL.md`;
const credentialFile = process.env.DEVILUDO_PROVIDER_CREDENTIAL_FILE ?? "/run/deviludo/provider-credential";
const mcpTokenFile = process.env.DEVILUDO_MCP_TOKEN_FILE ?? "/run/deviludo/mcp-token";
const startedAt = new Date().toISOString();
const previous = await readJson(sessionFile);
const nativeSessionId = previous?.nativeSessionId ?? randomUUID();
await verifySkillManifest();
await installNativeSkills();
const skillName = `deviludo-${request.role.toLowerCase()}`;
const contextPath = process.env.DEVILUDO_PROJECT_CONTEXT_FILE ?? "/workspace/context/project-context.json.zst";
const sourceDirectory = process.env.DEVILUDO_PROJECT_SOURCE_DIR ?? "/workspace/project";
const prompt = [
  `Use the installed, signed ${skillName} Skill for this turn. Its instructions are mandatory.`,
  `Current role: ${request.role}. Turn mode: ${request.mode}.`,
  `The canonical compressed project context is mounted at ${contextPath}. Use context.read instead of attempting to decode or edit it.`,
  request.mode === "COMPACT" ? "Compaction mode is summary-only: do not use mutating tools, edit source, or start workflow work. Return a restoration-ready structured summary." : "",
  request.mode === "READ_ONLY_BRANCH" ? "This is a read-only branch. Answer the question only. Do not mutate project state or files." : "This is the primary role session. Use only authorized tools for durable state changes.",
  request.attachmentPaths.length ? `Inspect the player attachments at these read-only turn paths:\n${request.attachmentPaths.join("\n")}` : "",
  request.prompt,
].join("\n\n");
const environment = {
  ...process.env,
  HOME: "/var/lib/deviludo-runtime/home",
  CODEX_HOME: `${stateRoot}/codex`,
  DEVILUDO_AGENT_ROLE: request.role,
  DEVILUDO_AGENT_TURN_ID: request.turnId,
  DEVILUDO_MCP_TOKEN_FILE: mcpTokenFile,
  DEVILUDO_PROJECT_CONTEXT_FILE: contextPath,
};
const credential = (await readFile(credentialFile, "utf8")).trim();
let command;
let args;
let input;
let codexAuthFile = null;
let ephemeralCodexHome = null;
if (request.runtime === "CLAUDE_CODE") {
  environment.ANTHROPIC_API_KEY = credential;
  environment.ANTHROPIC_AUTH_TOKEN = credential;
  environment.ANTHROPIC_BASE_URL = request.baseUrl;
  environment.ANTHROPIC_MODEL = request.model;
  environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  const writable = request.role === "DEVELOPMENT" && request.mode === "PRIMARY";
  args = [
    "-p", "--bare", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
    "--max-turns", "100", "--tools", writable
      ? "Read,Write,Edit,Glob,Grep,Bash,mcp__deviludo__*"
      : "Read,Glob,Grep,mcp__deviludo__*",
    "--disallowedTools", "Agent,Task,WebFetch,WebSearch", "--dangerously-skip-permissions",
    "--mcp-config", "/opt/deviludo/mcp.json", "--strict-mcp-config",
    previous ? "--resume" : "--session-id", nativeSessionId,
  ];
  if (request.mode === "READ_ONLY_BRANCH" && previous) args.push("--fork-session");
  args.push(prompt);
  command = "claude";
} else {
  ephemeralCodexHome = `/run/deviludo/${request.turnId}/codex-home`;
  environment.CODEX_HOME = ephemeralCodexHome;
  await prepareCodexHome(ephemeralCodexHome);
  environment.DEVILUDO_CODEX_PROVIDER_API_KEY = credential;
  const official = new URL(request.baseUrl).hostname === "chatgpt.com";
  if (official) {
    await mkdir(environment.CODEX_HOME, { recursive: true, mode: 0o700 });
    codexAuthFile = `${environment.CODEX_HOME}/auth.json`;
    await writeFile(codexAuthFile, credential, { mode: 0o600 });
    delete environment.DEVILUDO_CODEX_PROVIDER_API_KEY;
  }
  const provider = official ? "deviludo_chatgpt" : "deviludo_custom";
  args = ["exec", "--json", "--ignore-user-config",
    "--ignore-rules",
    "--config", `model_provider=${provider}`,
    "--config", `model_providers.${provider}.name=DeviLudo`,
    "--config", `model_providers.${provider}.base_url=${official ? "https://chatgpt.com/backend-api/codex" : request.baseUrl}`,
    "--config", "model_providers.${provider}.wire_api=responses".replace("${provider}", provider),
    "--config", `model_providers.${provider}.requires_openai_auth=${official}`,
    "--config", `model_providers.${provider}.supports_websockets=false`,
    "--config", `mcp_servers.deviludo.command=/usr/local/bin/deviludo-mcp`,
    "--skip-git-repo-check",
    ...(request.mode === "READ_ONLY_BRANCH" || request.role !== "DEVELOPMENT" ? ["--sandbox", "read-only"] : ["--dangerously-bypass-approvals-and-sandbox"]),
  ];
  if (!official) args.push("--config", `model_providers.${provider}.env_key=DEVILUDO_CODEX_PROVIDER_API_KEY`);
  if (request.model !== "account-default") args.push("-m", request.model);
  for (const attachmentPath of request.attachmentPaths) args.push("-i", attachmentPath);
  args.push("-C", sourceDirectory);
  // Every turn gets an isolated CODEX_HOME copy. A read-only branch can resume
  // the latest role transcript in that copy, answer with full context, and be
  // discarded without mutating the primary session history.
  if (previous) args.push("resume", nativeSessionId, "-");
  else args.push("-");
  command = "codex";
  input = prompt;
}

const result = await run(command, args, environment, input).finally(async () => {
  if (ephemeralCodexHome && request.mode !== "READ_ONLY_BRANCH") {
    await persistCodexSessions(ephemeralCodexHome);
  }
  await Promise.all([
    rm(credentialFile, { force: true }),
    rm(mcpTokenFile, { force: true }),
    ...(codexAuthFile ? [rm(codexAuthFile, { force: true })] : []),
  ]);
});
const sessionId = result.sessionId ?? nativeSessionId;
if (request.mode !== "READ_ONLY_BRANCH") {
  await mkdir(`${stateRoot}/sessions`, { recursive: true, mode: 0o700 });
  await writeFile(sessionFile, JSON.stringify({ nativeSessionId: sessionId, role: request.role, updatedAt: new Date().toISOString() }), { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({
  schemaVersion: "deviludo.project-runtime.v2",
  turnId: request.turnId,
  role: request.role,
  mode: request.mode,
  content: result.content,
  structured: structuredOutput(result.content),
  toolCalls: result.toolCalls,
  sessionId,
  branchId: request.mode === "READ_ONLY_BRANCH" ? sessionId : null,
  sourceRevision: request.sourceRevision,
  startedAt,
  completedAt: new Date().toISOString(),
})}\n`);

async function run(executable, args, env, stdin) {
  const child = spawn(executable, args, { cwd: sourceDirectory, env, stdio: ["pipe", "pipe", "pipe"] });
  if (stdin) child.stdin.end(stdin); else child.stdin.end();
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  const content = [];
  const toolCalls = [];
  let sessionId = null;
  child.stdout.on("data", chunk => {
    const text = decoder.decode(chunk, { stream: true });
    stdout += text;
    process.stderr.write(text.split(/\r?\n/).filter(Boolean).map(line => `DEVILUDO_RUNTIME_EVENT:${line}\n`).join(""));
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    sessionId ??= event.session_id ?? event.thread_id ?? event.threadId ?? null;
    const text = event.result ?? event.message?.content?.find?.(part => part.type === "text")?.text
      ?? event.item?.content?.find?.(part => part.type === "output_text")?.text;
    if (typeof text === "string") content.push(text);
    if (event.type?.includes?.("tool") || event.item?.type?.includes?.("tool")) {
      toolCalls.push({ name: String(event.name ?? event.item?.name ?? "tool"), arguments: {}, result: {}, startedAt, completedAt: new Date().toISOString() });
    }
  }
  if (exitCode !== 0) throw new Error(`${executable} exited ${String(exitCode)}: ${stderr.slice(-4000)}`);
  return { content: content.at(-1) ?? stdout.trim(), toolCalls, sessionId };
}

function structuredOutput(content) {
  const match = content.match(/```json\s*([\s\S]*?)```/i);
  const candidate = match?.[1] ?? content;
  try {
    const value = JSON.parse(candidate.trim());
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

function validateRequest(value) {
  if (!value || value.schemaVersion !== "deviludo.project-runtime.v2"
    || !["INTENT", "ANALYSIS", "DESIGN", "DEVELOPMENT", "TEST"].includes(value.role)
    || !["PRIMARY", "READ_ONLY_BRANCH", "COMPACT"].includes(value.mode)
    || !["CLAUDE_CODE", "CODEX_CLI"].includes(value.runtime)
    || !/^[0-9a-f-]{36}$/i.test(value.turnId)
    || typeof value.prompt !== "string" || value.prompt.length < 1 || value.prompt.length > 100000
    || typeof value.baseUrl !== "string" || typeof value.model !== "string") {
    throw new Error("Project Runtime turn request is invalid");
  }
}

async function verifySkillManifest() {
  const manifest = await readFile("/opt/deviludo/skills.sha256", "utf8");
  const expected = new Map(manifest.trim().split(/\r?\n/).map(line => {
    const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!match) throw new Error("Signed Skill manifest is invalid");
    return [match[2], match[1]];
  }));
  const expectedHash = expected.get(skillFile);
  if (!expectedHash) throw new Error(`The ${request.role} Skill is not signed into this Runtime image`);
  const actualHash = createHash("sha256").update(await readFile(skillFile)).digest("hex");
  if (actualHash !== expectedHash) throw new Error(`The ${request.role} Skill signature is invalid`);
}

async function installNativeSkills() {
  const sourceRoot = "/opt/deviludo/skills";
  const destinations = [
    `${stateRoot}/codex/skills`,
    `${stateRoot}/home/.claude/skills`,
  ];
  for (const destination of destinations) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const role of ["intent", "analysis", "design", "development", "test"]) {
      const target = `${destination}/deviludo-${role}`;
      await rm(target, { recursive: true, force: true });
      await cp(`${sourceRoot}/${role}`, target, { recursive: true });
    }
  }
}

async function prepareCodexHome(destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const saved = `${stateRoot}/codex-sessions/${request.role.toLowerCase()}`;
  try { await cp(saved, `${destination}/sessions`, { recursive: true }); } catch {}
  await mkdir(`${destination}/skills`, { recursive: true, mode: 0o700 });
  for (const role of ["intent", "analysis", "design", "development", "test"]) {
    await cp(`/opt/deviludo/skills/${role}`, `${destination}/skills/deviludo-${role}`, { recursive: true });
  }
}

async function persistCodexSessions(source) {
  const sessions = `${source}/sessions`;
  const destination = `${stateRoot}/codex-sessions/${request.role.toLowerCase()}`;
  await rm(destination, { recursive: true, force: true });
  try {
    await mkdir(`${stateRoot}/codex-sessions`, { recursive: true, mode: 0o700 });
    await cp(sessions, destination, { recursive: true });
  } catch {}
}
