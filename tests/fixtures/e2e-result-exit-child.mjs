import { createInterface } from "node:readline";
import { closeLineInput } from "../../deploy/assets/e2e-process-lifecycle.mjs";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = input[Symbol.asyncIterator]();
const first = await lines.next();
if (first.done || JSON.parse(first.value)?.type !== "execute") throw new Error("missing execute frame");
process.stdout.write(`${JSON.stringify({ type: "result", value: { outcome: "FAILED" } })}\n`);
closeLineInput(input, process.stdin);
