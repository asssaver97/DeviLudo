#!/usr/bin/env node
import { request } from "node:http";
import { StringDecoder } from "node:string_decoder";

const action = process.argv[2];
if (!["execute", "health", "live", "guidance"].includes(action)) throw new Error("Only execute, guidance, live, and health commands are supported");
const socketPath = process.env.DEVILUDO_EXECUTOR_SOCKET ?? "/run/deviludo-executor/executor.sock";
const chunks = [];
if (action !== "health") for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks);
if (action === "execute" && (body.length < 2 || body.length > 2 * 1024 * 1024)) throw new Error("Sandbox plan size is invalid");
if (action === "guidance" && (body.length < 2 || body.length > 16 * 1024)) throw new Error("Guidance size is invalid");

const response = await new Promise((resolve, reject) => {
  const execution = { error: false };
  const streamDecoder = new StringDecoder("utf8");
  const path = action === "execute"
    ? "/v2/execute"
    : action === "guidance" ? "/v2/guidance"
      : action === "live" ? "/v2/live" : "/v2/health";
  const call = request({ socketPath, path, method: "POST", headers: {
    "content-type": "application/json",
    "content-length": String(body.length),
  } }, result => {
    const output = [];
    let streamBuffer = "";
    result.on("data", chunk => {
      if (action !== "execute" || result.statusCode !== 200) {
        output.push(chunk);
        return;
      }
      streamBuffer += streamDecoder.write(chunk);
      const lines = streamBuffer.split(/\r?\n/);
      streamBuffer = lines.pop() ?? "";
      for (const line of lines) consumeExecutionEvent(line, output, execution);
    });
    result.on("end", () => {
      if (action === "execute" && result.statusCode === 200) streamBuffer += streamDecoder.end();
      if (action === "execute" && result.statusCode === 200 && streamBuffer.trim()) {
        consumeExecutionEvent(streamBuffer, output, execution);
      }
      resolve({ status: execution.error ? 422 : result.statusCode ?? 500, body: Buffer.concat(output) });
    });
  });
  call.once("error", reject);
  if (action !== "execute") call.setTimeout(5_000, () => call.destroy(new Error("Sandbox executor request timed out")));
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
