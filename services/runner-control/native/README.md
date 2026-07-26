# Windows SCM native components

The Physical Runner and Steam Client Connector are Node single-executable
applications, not native Windows services. The Steam Depot Finalizer is a
signed Node service artifact. Windows hosts run all three only through
`deviludo-windows-scm-service-bridge.exe` 1.1 or newer.

The bridge implements `StartServiceCtrlDispatcherW`, reports SCM state, accepts
only the three built-in DeviLudo service names, reads a fixed registry contract,
rehashes the exact target with Windows CNG SHA-256, launches it without a shell
inside a kill-on-close Job Object, and destroys the child when SCM stops the
service. It rejects inline credential-like environment names and accepts no
runtime command arguments for Runner services. The Finalizer has exactly one
argument: the release-addressed service artifact whose path and SHA-256 digest
are derived from the signed transaction environment. `--identity` is the sole
offline inspection mode.

Production builds run only on the approved Windows MSVC builder. The CMake
configuration enables control-flow guard, CET compatibility, ASLR, DEP, stack
cookies, SDL checks, link-time optimization and warnings-as-errors. The PE must
then receive Authenticode signing, malware/vulnerability evidence and an
Ed25519 platform manifest before a service transaction can become `READY`.

The privileged host actuator writes these fixed values below
`HKLM\\SYSTEM\\CurrentControlSet\\Services\\<built-in-name>\\Parameters`:

- `BridgeContractVersion` (`REG_DWORD`, exactly `1`)
- `TargetExecutable` (`REG_SZ`, exact revision-addressed SEA path)
- `TargetDigest` (`REG_SZ`, 64 lowercase SHA-256 hex)
- `DescriptorDigest` (`REG_SZ`, the signed transaction descriptor digest)
- `Environment` (`REG_MULTI_SZ`, sorted, unique, secret-free entries)
- `TargetArgument`, `TargetArgumentDigest`, `WorkingDirectory` (Finalizer only;
  exact immutable service artifact, digest, and its parent release directory)

No administrator-supplied script, executable name, service name or argument is
accepted by the bridge.

`deviludo-windows-scm-native-actuator.exe` is the separate privileged boundary
that installs those fixed services. It accepts only `--identity`, `--apply`,
`--restore` and `--probe`; it never invokes `sc.exe`, `reg.exe`, PowerShell or a
shell. The actuator reads only
`%ProgramData%\DeviLudo\NativeActuator\actuation-request.v1.bin`, whose bounded
little-endian v1 format contains the exact transaction, bridge, target,
descriptor and sorted environment digests. It rehashes each PE while holding a
non-delete/non-write shared handle, then calls SCM and Registry APIs directly.
For the Finalizer it also rehashes the service artifact, applies a restricted
service SID with an empty required-privilege set, and starts only the fixed
`node.exe <signed-service-artifact>` command.

Actuation is crash recoverable. Before mutation the actuator creates
`pending-request.v1.bin`; the last successful request remains
`active-request.v1.bin`. A subsequent `--apply` or explicit `--restore`
restores the active request before accepting another transition. Successful
configuration writes a replacement active request with `MoveFileExW(...,
MOVEFILE_WRITE_THROUGH)` and removes the pending marker. The ProgramData
directory and inbox ACL are provisioned by the Windows machine image. Request
files must be owned by LocalSystem or Built-in Administrators and grant no
effective write/delete/ACL-owner rights to Everyone, Authenticated Users or
Built-in Users; the actuator rechecks this before parsing. The platform
delivery step therefore runs under the machine's dedicated LocalSystem broker.

The bridge and actuator are separate Authenticode-signed PE files with separate
Ed25519 trust policies and KMS keys. CMake builds both only under an approved
64-bit MSVC Windows builder. The actuator release manifest binds request
contract version 1; a service transaction cannot become `READY` until both
independent manifests and exact binaries verify.
