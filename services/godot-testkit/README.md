# Godot TestKit v2

This service is the platform-owned execution controller used by physical
Windows, Linux and macOS Runners. It is not an autonomous Agent and it never
executes project-provided commands, hooks, plugins, MCP servers or test code.

For a server-signed Runner job it:

1. downloads the canonical frozen matrix test plan and, for source gates, only
   the exact content-addressed `source.tar.zst` authorized by the job;
2. for source gates, extracts the fixed Zstandard/USTAR subset into a private
   fresh workspace, rejecting traversal, links, `.git`, duplicates and
   resource-limit drift;
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

For `STEAM_CLEAN_INSTALL`, the controller deliberately does not download source
or export another build. `MtlsSteamInstalledGameDriver` sends the signed job and
canonical plan to a platform-local, Agent-free Steam Client Connector over TLS
1.3 mTLS. The Connector alone resolves the opaque install grant and must return
an exact receipt for clean-client reset, the locked AppID/BuildID/private branch
installation, production boot and the fixed platform suite. TestKit recomputes
the receipt digest, rejects path escape/symlinks, parses the standard harness
result, verifies screenshot/video files and packages the actual installed tree
as production evidence. Account passwords, Steam Guard values, Beta passwords,
`config.vdf` and Vault references are neither request nor response fields.

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

Each target OS installs a platform-native, read-only
`/opt/deviludo-testkit/bin/deviludo-testkit` equivalent built together with the
Physical Runner and Steam Client Connector by `npm run build:runner-native`.
The command pins Node, esbuild, postject and the package lock, executes all
three SEA identities, and emits
an immutable candidate receipt. The isolated native-signing pipeline must add
Developer ID plus notarization, Authenticode or Sigstore evidence as appropriate;
`npm run verify:runner-native` then verifies the dedicated Ed25519 release
envelope, final files and embedded identities on the target host. Full commands
and schemas are in `docs/runner-native-release.md`. The verified SHA-256 is
published in the `RunnerExecutionLock` and machine configuration, and the
physical Runner hashes the complete executable before every attempt. A launcher
that imports mutable repository files is not acceptable.

The production executable accepts exactly:

```text
deviludo-testkit run --request-file <private-run-dir>/request.json \
  --output-file <private-run-dir>/result.json
```

The request and result basenames and canonical parent directory are fixed.
Production deployment remains blocked until every selected Runner system has a
verified final native release; the local `tsx` command and a raw build candidate
are deliberately not presented as release artifacts.

The Steam Client Connector is the third signed component in that release, but
is installed only on Steam-capable hosts under a separate OS account and mTLS
identity. Its platform-specific UI bridge remains separately signed and
Runner-bound. This repository does not fabricate a Steam installation on
localhost. A physical Windows/Linux/macOS gate remains blocked until the
Connector, UI bridge and clean Steam Client sandbox are deployed and their
digests are admitted by fleet policy.

The child gets only private home/temp paths, locale/platform session variables,
and the explicit mTLS artifact transport configuration. Provider keys, Steam
credentials, arbitrary host environment variables and artifact Broker secrets
are never forwarded to Godot. Linux graphical hosts may supply only the fixed
`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`,
`PULSE_SERVER` and `PIPEWIRE_REMOTE` session allowlist.
