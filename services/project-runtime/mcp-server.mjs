#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  canonicalToolName,
  nativeToolName,
  ROLE_TO_CANONICAL_TOOLS,
  toolInputSchema,
} from "./tool-names.mjs";

const role = process.env.DEVILUDO_AGENT_ROLE ?? "";
const turnId = process.env.DEVILUDO_AGENT_TURN_ID ?? "";
const tokenFile = process.env.DEVILUDO_MCP_TOKEN_FILE ?? "/run/deviludo/mcp-token";
const gateway = process.env.DEVILUDO_MCP_GATEWAY ?? "";
const workspaceId = process.env.DEVILUDO_WORKSPACE_ID ?? "";
const projectId = process.env.DEVILUDO_PROJECT_ID ?? "";

if (!(role in ROLE_TO_CANONICAL_TOOLS) || !gateway.startsWith("http://") || ![turnId, workspaceId, projectId].every(value => /^[0-9a-f-]{36}$/i.test(value))) {
  throw new Error("Project MCP identity is invalid");
}

const definitions = ROLE_TO_CANONICAL_TOOLS[role].map(canonicalName => Object.freeze({
  name: nativeToolName(canonicalName),
  description: toolDescription(canonicalName),
  inputSchema: toolInputSchema(canonicalName),
}));

let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString("utf8");
  consume().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
});

async function consume() {
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) await handle(JSON.parse(line));
  }
}

async function handle(message) {
  if (message.method === "notifications/initialized") return;
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    return send(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "deviludo-project", version: "2.0.0" } });
  }
  if (message.method === "tools/list") return send(message.id, { tools: definitions });
  if (message.method === "tools/call") {
    const nativeName = message.params?.name;
    const name = canonicalToolName(role, nativeName);
    if (!name) return sendError(message.id, -32602, `Tool ${String(nativeName)} is not authorized for ${role}`);
    try {
      const token = (await readFile(tokenFile, "utf8")).trim();
      const response = await fetch(new URL("/v2/runtime/tools/call", gateway), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, projectId, role, turnId, name, arguments: message.params?.arguments ?? {} }),
        signal: AbortSignal.timeout(120_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message : `MCP Gateway returned ${response.status}`);
      return send(message.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return send(message.id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
    }
  }
  return sendError(message.id, -32601, "Method not found");
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function toolDescription(name) {
  if (name === "context.update_analysis") {
    return "Persist the complete imported-project analysis. Pass the canonical report in the required analysis object.";
  }
  if (name === "source.read") {
    return "Read a UTF-8 source file from the current immutable revision. For files larger than 1 MiB, provide a 1-based startLine/endLine range spanning at most 1000 lines.";
  }
  if (name === "project_document.update") {
    return "Confirm the exact approved project document snapshot. Pass it in the required document object; do not use projectDocument, projectDocumentPatch, content, or expectedRevision fields.";
  }
  if (name === "e2e_goals.update") {
    return "Confirm the exact frozen E2E goal snapshot. Pass the complete goal array in the required goals field.";
  }
  if (name === "handoff.create") {
    return "Create the durable current-turn handoff. Pass the destination role in toRole and the complete implementation-facing handoff in summary.";
  }
  if (name === "test_plan.replace") {
    return "Persist the complete current Test Agent plan. Follow this tool's input schema exactly and use only source-read Probe keys and semantic control IDs. A validation error is a correctable plan-authoring error: revise the payload and retry; it is not E2E infrastructure failure.";
  }
  return `DeviLudo built-in ${name} tool. Access is enforced for the ${role} role and audited by turn.`;
}
