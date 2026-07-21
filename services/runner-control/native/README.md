# Windows SCM service bridge

The Physical Runner and Steam Client Connector are Node single-executable
applications, not native Windows services. Windows hosts therefore run them
only through `deviludo-windows-scm-service-bridge.exe`.

The bridge implements `StartServiceCtrlDispatcherW`, reports SCM state, accepts
only the two built-in DeviLudo service names, reads a fixed registry contract,
rehashes the exact target with Windows CNG SHA-256, launches it without a shell
inside a kill-on-close Job Object, and destroys the child when SCM stops the
service. It rejects inline credential-like environment names and accepts no
runtime command arguments. `--identity` is the sole offline inspection mode.

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

No administrator-supplied script, executable name, service name or argument is
accepted by the bridge.
