param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$SigningCertificateThumbprint,
  [Parameter(Mandatory=$true)][string]$RepositoryRoot,
  [Parameter(Mandatory=$true)][string]$GodotPath
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$driver=Join-Path $root 'driver\DeviLudoVhfGamepad.vcxproj'
$relay=Join-Path $root 'relay\DeviLudo.GamepadRelay.csproj'
$stage=Join-Path $OutputDirectory 'driver'
New-Item -ItemType Directory -Force $stage | Out-Null
& msbuild.exe $driver '/p:Configuration=Release' '/p:Platform=x64' "/p:OutDir=$stage\"
if($LASTEXITCODE -ne 0){throw 'VHF driver build failed'}
& dotnet publish $relay -c Release -r win-x64 --self-contained true "/p:PublishDir=$OutputDirectory\relay\"
if($LASTEXITCODE -ne 0){throw 'VHF relay build failed'}
$inf=Join-Path $stage 'DeviLudoVhfGamepad.inf'
& inf2cat.exe "/driver:$stage" '/os:10_X64,Server10_X64'
if($LASTEXITCODE -ne 0){throw 'VHF catalog generation failed'}
foreach($file in @((Join-Path $stage 'DeviLudoVhfGamepad.sys'),(Join-Path $stage 'DeviLudoVhfGamepad.cat'))){
  & signtool.exe sign /sha1 $SigningCertificateThumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $file
  if($LASTEXITCODE -ne 0){throw "VHF signing failed: $file"}
}
& pnputil.exe /add-driver $inf /install
if($LASTEXITCODE -ne 0){throw 'VHF driver installation failed'}
$target='C:\Program Files\Deviludo\vhf-gamepad-driver.exe'
New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
Copy-Item -LiteralPath (Join-Path $OutputDirectory 'relay\vhf-gamepad-driver.exe') -Destination $target -Force
$env:DEVILUDO_GAMEPAD_DRIVER=$target
$env:DEVILUDO_GODOT=$GodotPath
& node.exe (Join-Path $RepositoryRoot 'scripts\executors\godot-system-gamepad-smoke.mjs') (Join-Path $RepositoryRoot 'fixtures\godot-input-smoke')
if($LASTEXITCODE -ne 0){throw 'Godot system gamepad smoke failed'}
