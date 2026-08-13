# Windows virtual gamepad

The Windows E2E golden image contains this repository-built, signed VHF gamepad and its JSONL relay. The kernel component uses Microsoft’s supported KMDF/VHF path; VHF is not implemented as UMDF2. The relay can only submit complete gamepad reports through an administrator/System-only device handle and always sends a neutral report on exit.

Build and install from an elevated WDK shell:

```powershell
.\build-and-install.ps1 -OutputDirectory C:\DeviLudoBuild -SigningCertificateThumbprint $env:DEVILUDO_DRIVER_SIGNING_CERTIFICATE -RepositoryRoot C:\DeviLudo -GodotPath 'C:\Program Files\Godot\Godot.exe'
```

The resulting golden image must pass the real Godot input smoke before its digest can be configured for an E2E node.
