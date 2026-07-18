# Godot TestKit v2

This service is the platform-owned execution controller used by physical
Windows, Linux and macOS Runners. It is not an autonomous Agent and it never
executes project-provided commands, hooks, plugins, MCP servers or test code.

For a server-signed Runner job it:

1. downloads only the exact content-addressed `source.tar.zst` and canonical
   frozen matrix test plan authorized by the job;
2. extracts the fixed Zstandard/USTAR subset into a private fresh workspace,
   rejecting traversal, links, `.git`, duplicates and resource-limit drift;
3. verifies the pinned Godot binary, then runs only the platform-owned import,
   boot, scenario harness, release export and exported-game boot commands with
   `execFile`, `shell: false` and fixed arguments;
4. evaluates the required core-loop, win, lose, pause/settings and save/load
   outcomes, complete input timeline, planned screenshots and performance
   budgets;
5. creates logs, JUnit, input timeline, screenshot package, video package and
   production-export package, all content-addressed and bound to the signed job;
6. writes an immutable local preparation record before upload so a restart
   uploads identical evidence without running the game a second time.

A passing result requires all five fixed Godot commands, a complete passing
harness and at least one non-empty production export file. The total configured
command timeout is capped at 3,000 seconds and the signed Runner lease must have
that worst-case duration plus a five-minute evidence margin remaining.

## Local contract testing

From the repository root:

```bash
npm run test:godot-testkit
```

The suite runs the real platform harness with the installed Godot binary. A
headless host exercises the real scenario DSL; screenshot/video capture is
explicitly skipped when the host cannot expose a graphical movie-capture
session. Unit tests still verify the exact screenshot/video transport contract.
No test converts a missing graphical session into a passing physical E2E result.

`npm run start:godot-testkit -- run ...` is a source-tree development entry and
uses `tsx`. It is not a production Runner artifact.

## Production packaging boundary

Each target OS must install a platform-native, read-only
`/opt/deviludo-testkit/bin/deviludo-testkit` equivalent built from this service
as one self-contained artifact. The build pipeline must pin Node and all
dependencies, generate SBOM and vulnerability/malware results, sign the
artifact, and publish its SHA-256 in the `RunnerExecutionLock` and machine
configuration. The physical Runner hashes the complete executable before every
attempt. A launcher that imports mutable repository files is not acceptable.

The production executable accepts exactly:

```text
deviludo-testkit run --request-file <private-run-dir>/request.json \
  --output-file <private-run-dir>/result.json
```

The request and result basenames and canonical parent directory are fixed.
Production deployment remains blocked until the release pipeline has produced
and signed the native artifacts for all selected Runner systems; the local
`tsx` command is deliberately not presented as that release artifact.

The child gets only private home/temp paths, locale/platform session variables,
and the explicit mTLS artifact transport configuration. Provider keys, Steam
credentials, arbitrary host environment variables and artifact Broker secrets
are never forwarded to Godot. Linux graphical hosts may supply only the fixed
`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`,
`PULSE_SERVER` and `PIPEWIRE_REMOTE` session allowlist.
