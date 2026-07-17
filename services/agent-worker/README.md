# DeviLudo Agent Worker

This service-side module executes immutable `RuntimeSpec` plans produced by the
Claude Code and Codex CLI adapters. It is intended for a one-run-per-microVM
worker and does not perform Agent selection or Provider fallback.

Security properties enforced immediately before process creation:

- fixed `claude`/`codex` executable binding and `shell: false`;
- normalized run-root and workspace containment for cwd, runtime files, homes,
  and absolute argv paths;
- rejection of permission-bypass flags and non-allowlisted environment keys;
- opaque SecretRef resolution into the child process only;
- bounded JSONL and stderr collection with value-aware redaction;
- timeout and cancellation through `SIGTERM`, followed by bounded `SIGKILL`;
- explicit exit code, signal, timeout, cancellation, and adapter diagnostics.

The contract tests inject a fake spawn implementation and never invoke an
installed Agent CLI:

```sh
npx tsc -p services/agent-worker/tsconfig.json --pretty false
node --import tsx --test services/agent-worker/test/supervisor.test.ts
```
