#!/usr/bin/env node
import { request } from "node:http";
import { StringDecoder } from "node:string_decoder";

const action = process.argv[2];
const actions = ["execute", "health", "live", "runtime-ensure", "runtime-turn", "runtime-pause", "runtime-resume", "runtime-destroy", "runtime-status", "runtime-list"];
if (!actions.includes(action)) throw new Error("Unsupported executor command");
const socketPath = process.env.DEVILUDO_EXECUTOR_SOCKET ?? "/run/deviludo-executor/executor.sock";
const chunks = [];
if (!["health", "live", "runtime-list"].includes(action)) for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks);
if (action === "execute" && (body.length < 2 || body.length > 2 * 1024 * 1024)) throw new Error("Sandbox plan size is invalid");
if (action.startsWith("runtime-") && action !== "runtime-list" && (body.length < 2 || body.length > 2 * 1024 * 1024)) {
  throw new Error("Project Runtime request size is invalid");
}

const response = await new Promise((resolve, reject) => {
  const execution = { error: false };
  const streamDecoder = new StringDecoder("utf8");
  const path = action === "execute" ? "/v2/execute"
    : action === "live" ? "/v2/live"
      : action === "health" ? "/v2/health"
        : `/v2/runtime/${action.slice("runtime-".length)}`;
  const call = request({ socketPath, path, method: "POST", headers: {
    "content-type": "application/json",
    "content-length": String(body.length),
  } }, result => {
    const output = [];
    let streamBuffer = "";
    result.on("data", chunk => {
      if (!["execute", "runtime-turn"].includes(action) || result.statusCode !== 200) {
        output.push(chunk);
        return;
      }
      streamBuffer += streamDecoder.write(chunk);
      const lines = streamBuffer.split(/\r?\n/);
      streamBuffer = lines.pop() ?? "";
      for (const line of lines) consumeStreamEvent(action, line, output, execution);
    });
    result.on("end", () => {
      if (["execute", "runtime-turn"].includes(action) && result.statusCode === 200) streamBuffer += streamDecoder.end();
      if (["execute", "runtime-turn"].includes(action) && result.statusCode === 200 && streamBuffer.trim()) {
        consumeStreamEvent(action, streamBuffer, output, execution);
      }
      resolve({ status: execution.error ? 422 : result.statusCode ?? 500, body: Buffer.concat(output) });
    });
  });
  call.once("error", reject);
  const timeout = action === "runtime-turn" ? 24 * 60 * 60_000 : action === "execute" ? 0 : 30_000;
  if (timeout > 0) call.setTimeout(timeout, () => call.destroy(new Error("Sandbox executor request timed out")));
  call.end(body);
});
if (response.status !== 200) {
  process.stderr.write(response.body.toString("utf8").slice(0, 4000));
  process.exit(1);
}
process.stdout.write(response.body);

function consumeExecutionEvent(line, output, execution) {
  if (!line.trim()) return;
  const event = JSON.parse(line);
  if (event.type === "progress" && event.event
    && ["PHASE", "AGENT_OUTPUT"].includes(event.event.kind)
    && typeof event.event.content === "string") {
    process.stderr.write(`DEVILUDO_PROGRESS:${JSON.stringify(event.event)}\n`);
    return;
  }
  if (event.type === "complete" && event.receipt) {
    output.push(Buffer.from(JSON.stringify(event.receipt)));
    return;
  }
  if (event.type === "error" && typeof event.message === "string") {
    execution.error = true;
    output.push(Buffer.from(event.message));
    return;
  }
  throw new Error("Executor returned an invalid execution event");
}

function consumeStreamEvent(action, line, output, execution) {
  if (action === "execute") return consumeExecutionEvent(line, output, execution);
  if (!line.trim()) return;
  const event = JSON.parse(line);
  if (event.type === "progress" && typeof event.content === "string") {
    process.stderr.write(`DEVILUDO_RUNTIME_PROGRESS:${JSON.stringify({ content: event.content })}\n`);
    return;
  }
  if (event.type === "complete" && event.result) {
    output.push(Buffer.from(JSON.stringify(event.result)));
    return;
  }
  if (event.type === "error" && typeof event.message === "string") {
    execution.error = true;
    output.push(Buffer.from(event.message));
    return;
  }
  throw new Error("Executor returned an invalid Project Runtime event");
}
