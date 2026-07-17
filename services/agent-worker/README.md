# DeviLudo Agent Worker

This service-side module executes immutable `RuntimeSpec` plans produced by the
Claude Code and Codex CLI adapters. It is intended for a one-run-per-microVM
worker and does not perform Agent selection or Provider fallback.

Security properties enforced immediately before process creation:

- fixed `claude`/`codex` executable binding and `shell: false`;
- pre-spawn verification of the exact CLI version and immutable WorkerImage
  digest selected when the task was queued;
- exclusive, no-follow materialization of Adapter settings/schema files with
  `0400`/`0600` modes; existing files and symlink parents are rejected;
- normalized run-root and workspace containment for cwd, runtime files, homes,
  and absolute argv paths;
- rejection of permission-bypass flags and non-allowlisted environment keys;
- opaque SecretRef resolution into the child process only;
- bounded JSONL and stderr collection with value-aware redaction;
- timeout and cancellation through `SIGTERM`, followed by bounded `SIGKILL`;
- explicit exit code, signal, timeout, cancellation, and adapter diagnostics.

The contract tests inject the process boundary and verify call ordering,
version/image mismatch rejection, file modes, overwrite protection and symlink
defence without invoking an installed Agent CLI:

```sh
npx tsc -p services/agent-worker/tsconfig.json --pretty false
node --import tsx --test services/agent-worker/test/supervisor.test.ts
```
