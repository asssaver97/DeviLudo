import { runNativeAgentExecutionWorkerService } from "./run-native-worker-service";

// Dedicated bundle entry: unlike source-mode CLI detection, this remains exact
// when the executing path traverses a host symlink such as /var -> /private/var.
void runNativeAgentExecutionWorkerService().catch(() => {
  process.stderr.write(`${JSON.stringify({
    service: "deviludo-agent-execution-worker",
    event: "FAILED",
  })}\n`);
  process.exitCode = 1;
});
