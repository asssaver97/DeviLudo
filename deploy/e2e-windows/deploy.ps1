param([Parameter(Mandatory=$true)][ValidateSet('preflight','bootstrap','deploy','status','rollback')][string]$Action)
$ErrorActionPreference='Stop'
$ConfigFile=if($env:DEVILUDO_CONFIG){$env:DEVILUDO_CONFIG}else{'C:\ProgramData\Deviludo\deploy.json'}
$Root='C:\Program Files\Deviludo'; $State='C:\ProgramData\Deviludo'; $Service='DeviludoE2E'; $ServiceAccount="NT SERVICE\$Service"
function Read-Config { if(!(Test-Path -LiteralPath $ConfigFile)){throw "Missing $ConfigFile"}; Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json }
function Test-RequiredFile {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Path)
  if(!(Test-Path -LiteralPath $Path)){throw "Required file is missing: $Path"}
}
function Set-RestrictedAcl {
  [CmdletBinding(SupportsShouldProcess=$true)]
  param([Parameter(Mandatory=$true)][string]$Path)
  if(!$PSCmdlet.ShouldProcess($Path,'Restrict access control list')){return}
  & icacls.exe $Path '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw "Failed to restrict ACLs on $Path"}
}
function Grant-ServiceAcl($Path,$Rights){
  & icacls.exe $Path '/grant:r' "${ServiceAccount}:$Rights" | Out-Null
  if($LASTEXITCODE -ne 0){throw "Failed to grant the E2E service access to $Path"}
}
function Get-ReleaseHeader {
  [CmdletBinding()]
  [OutputType([System.Collections.Hashtable])]
  param([Parameter(Mandatory=$true)]$Config)
  if(!$Config.releaseAuthHeaderFile){return @{}}
  Test-RequiredFile -Path $Config.releaseAuthHeaderFile
  $line=(Get-Content -LiteralPath $Config.releaseAuthHeaderFile -Raw).Trim()
  if($line -notmatch '^Authorization: Bearer [A-Za-z0-9._-]+$'){throw 'Release auth file must contain an Authorization: Bearer header'}
  return @{Authorization=$line.Substring('Authorization: '.Length)}
}
function Invoke-Preflight {
  $c=Read-Config; $os=Get-CimInstance Win32_OperatingSystem
  if($os.Caption -notmatch 'Windows 11 Pro'){throw 'Windows 11 Pro is required'}
  foreach($path in @($c.enrollmentTokenFile,$c.goldenVmFile,"$($c.goldenVmFile).pem","$($c.goldenVmFile).sig",$c.coreCaFile,$c.guestCredentialFile)){Test-RequiredFile -Path $path}
  if($c.coreUrl -notmatch '^https://'){throw 'Core must use HTTPS'}
  if(!$c.toolPath -or $c.toolPath -match "[`r`n]"){throw 'A fixed toolPath is required'}
  foreach($name in @('node','windowsSdk','openssl','nssm','cosign')){if($c.packageVersions.$name -notmatch '^[0-9][0-9A-Za-z.+-]{0,79}$'){throw "A fixed packageVersions.$name is required"}}
}
function Invoke-Bootstrap {
  Invoke-Preflight; $c=Read-Config
  if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator privileges are required'}
  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null
  $packages=@(
    @{Id='OpenJS.NodeJS.22';Version=$c.packageVersions.node},
    @{Id='Microsoft.WindowsSDK.10.0.26100';Version=$c.packageVersions.windowsSdk},
    @{Id='ShiningLight.OpenSSL.Light';Version=$c.packageVersions.openssl},
    @{Id='NSSM.NSSM';Version=$c.packageVersions.nssm},
    @{Id='Sigstore.Cosign';Version=$c.packageVersions.cosign}
  )
  foreach($package in $packages){winget install --id $package.Id --version $package.Version --exact --silent --accept-package-agreements --accept-source-agreements}
  New-Item -ItemType Directory -Force $Root,$State,(Join-Path $State 'credentials'),(Join-Path $State 'jobs') | Out-Null
  Set-RestrictedAcl -Path $State
}
function Test-ReleaseManifest {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)]$Config,[Parameter(Mandatory=$true)][string]$Stage)
  & cosign verify-blob --certificate "$Stage\release-manifest.json.pem" --signature "$Stage\release-manifest.json.sig" --certificate-identity-regexp $Config.cosignIdentityRegexp --certificate-oidc-issuer $Config.cosignIssuer "$Stage\release-manifest.json" | Out-Null
  $manifest=Get-Content "$Stage\release-manifest.json" -Raw | ConvertFrom-Json
  if($manifest.schemaVersion -ne 'deviludo.release.v1' -or $manifest.version -ne $Config.releaseVersion -or $manifest.roles -notcontains 'E2E_WINDOWS' -or $null -ne $manifest.plugins.GODOT.version -or $manifest.plugins.GODOT.testManifestContract -ne 'deviludo.test-manifest' -or $manifest.plugins.GODOT.guestReportContract -ne 'deviludo.godot-guest-report' -or $manifest.plugins.GODOT.evidenceContract -ne 'deviludo.e2e-evidence' -or @($manifest.plugins.GODOT.guestActions).Count -ne 1 -or $manifest.plugins.GODOT.guestActions[0] -ne 'test' -or $manifest.plugins.GODOT.runtimeInputSmoke -ne 'GODOT_SYSTEM_KEYBOARD_POINTER_GAMEPAD' -or $manifest.plugins.GODOT.gamepadBackends.windows -ne 'KMDF_VHF' -or $manifest.plugins.GODOT.gamepadBackends.linux -ne 'UINPUT' -or $manifest.plugins.GODOT.gamepadBackends.macos -ne 'CORE_HID' -or $manifest.plugins.GODOT.macosGoldenImage -ne 'TAHOE_26' -or $manifest.plugins.GODOT.artifactHostCommandsAllowed -ne $false -or $manifest.plugins.GODOT.builderImage -notmatch '@sha256:[0-9a-f]{64}$'){throw 'Release manifest is invalid'}
  return $manifest
}
function Test-GoldenVm {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)]$Config,[Parameter(Mandatory=$true)]$Manifest)
  & cosign verify-blob --certificate "$($Config.goldenVmFile).pem" --signature "$($Config.goldenVmFile).sig" --certificate-identity-regexp $Config.cosignIdentityRegexp --certificate-oidc-issuer $Config.cosignIssuer $Config.goldenVmFile | Out-Null
  $digest='sha256:'+((Get-FileHash -Algorithm SHA256 -LiteralPath $Config.goldenVmFile).Hash.ToLowerInvariant())
  if($digest -ne $Manifest.e2eRuntimeDigests.windows){throw 'Windows golden VM digest mismatch'}
}
function Initialize-Enrollment {
  [CmdletBinding(SupportsShouldProcess=$true)]
  param([Parameter(Mandatory=$true)]$Config,[Parameter(Mandatory=$true)][string]$Release)
  $credentials=Join-Path $State 'credentials'; $nodeIdFile=Join-Path $credentials 'node-id'
  if(Test-Path $nodeIdFile){return (Get-Content $nodeIdFile -Raw).Trim()}
  if(!$PSCmdlet.ShouldProcess($credentials,'Enroll E2E node')){return $null}
  $env:DEVILUDO_CORE_API_URL=$Config.coreUrl; $env:DEVILUDO_ENROLLMENT_TOKEN_FILE=$Config.enrollmentTokenFile
  $env:DEVILUDO_E2E_CORE_CA_FILE=$Config.coreCaFile; $env:DEVILUDO_E2E_CREDENTIAL_DIRECTORY=$credentials
  $env:DEVILUDO_E2E_POOL_KIND='E2E_WINDOWS'; $env:DEVILUDO_E2E_OPERATING_SYSTEM='windows'
  $env:Path="$($Config.toolPath);$env:Path"
  & 'C:\Program Files\nodejs\node.exe' (Join-Path $Release 'e2e-enroll.mjs')
  if($LASTEXITCODE -ne 0){throw 'E2E enrollment failed'}
  return (Get-Content $nodeIdFile -Raw).Trim()
}
function Get-ServiceEnvironment {
  [CmdletBinding()]
  [OutputType([System.Object[]])]
  param([Parameter(Mandatory=$true)]$Config,[Parameter(Mandatory=$true)][string]$NodeId,[Parameter(Mandatory=$true)][string]$GoldenVmFile)
  $credentials=Join-Path $State 'credentials'; $current=Join-Path $Root 'current'
  return @(
    'NODE_ENV=production',"DEVILUDO_E2E_NODE_ID=$NodeId",'DEVILUDO_E2E_POOL_KIND=E2E_WINDOWS',"DEVILUDO_CORE_API_URL=$($Config.coreUrl)","DEVILUDO_E2E_TOOL_PATH=$($Config.toolPath)",
    "DEVILUDO_E2E_CLIENT_CERT_FILE=$credentials\node.crt","DEVILUDO_E2E_CLIENT_KEY_FILE=$credentials\node-tls.key","DEVILUDO_E2E_CORE_CA_FILE=$credentials\core-ca.crt","DEVILUDO_E2E_IDENTITY_KEY_FILE=$credentials\receipt-ed25519.pem","DEVILUDO_E2E_CREDENTIAL_DIRECTORY=$credentials",
    "DEVILUDO_E2E_ISOLATION_EXECUTOR=$current\e2e-windows-isolation.cmd","DEVILUDO_E2E_TEST_EXECUTOR=$current\e2e-windows-job-executor.cmd","DEVILUDO_E2E_GUEST_RUNNER=$current\e2e-windows-guest-runner.cmd",
    "DEVILUDO_E2E_JOB_ROOT=$State\jobs","DEVILUDO_GOLDEN_VM_FILE=$GoldenVmFile","DEVILUDO_COSIGN_IDENTITY_REGEXP=$($Config.cosignIdentityRegexp)","DEVILUDO_COSIGN_ISSUER=$($Config.cosignIssuer)"
  )
}
function Set-ServiceConfiguration {
  [CmdletBinding(SupportsShouldProcess=$true)]
  param([Parameter(Mandatory=$true)]$Config,[Parameter(Mandatory=$true)][string]$NodeId,[Parameter(Mandatory=$true)][string]$GoldenVmFile)
  if(!$PSCmdlet.ShouldProcess($Service,'Configure E2E service')){return}
  $nssm=(Get-Command nssm.exe -ErrorAction Stop).Source; $node='C:\Program Files\nodejs\node.exe'; $entry=Join-Path $Root 'current\e2e-node.mjs'
  if(!(Get-Service $Service -ErrorAction SilentlyContinue)){& $nssm install $Service $node $entry | Out-Null}
  & sc.exe config $Service "obj= $ServiceAccount" 'password= ' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Failed to assign the restricted virtual service account'}
  & sc.exe sidtype $Service unrestricted | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Failed to enable the E2E service SID'}
  Grant-ServiceAcl $State '(OI)(CI)RX'
  Grant-ServiceAcl (Join-Path $State 'credentials') '(OI)(CI)M'
  Grant-ServiceAcl (Join-Path $State 'jobs') '(OI)(CI)M'
  Grant-ServiceAcl (Join-Path $State 'golden') '(OI)(CI)RX'
  & $nssm set $Service Application $node | Out-Null; & $nssm set $Service AppParameters ('"'+$entry+'"') | Out-Null
  & $nssm set $Service AppDirectory (Join-Path $Root 'current') | Out-Null
  & $nssm set $Service AppEnvironmentExtra (Get-ServiceEnvironment -Config $Config -NodeId $NodeId -GoldenVmFile $GoldenVmFile) | Out-Null
  & $nssm set $Service Start SERVICE_AUTO_START | Out-Null
  @{coreUrl=$Config.coreUrl;credentialDirectory=(Join-Path $State 'credentials')} | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $State 'node.json')
  $renewAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Program Files\Deviludo\current\e2e-windows-renew.ps1"'
  $renewTrigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(30) -RepetitionInterval (New-TimeSpan -Hours 12)
  $renewPrincipal=New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType ServiceAccount -RunLevel Limited
  Register-ScheduledTask -TaskName 'DeviludoE2ECertificateRenewal' -Action $renewAction -Trigger $renewTrigger -Principal $renewPrincipal -Force | Out-Null
}
function Invoke-Deploy {
  Invoke-Preflight; $c=Read-Config; $mutex=[Threading.Mutex]::new($false,'Global\DeviludoDeploy')
  if(!$mutex.WaitOne(0)){throw 'Another deployment is running'}
  try {
    $stage=Join-Path $State "stage-$([guid]::NewGuid())"; New-Item -ItemType Directory $stage | Out-Null
    $base="$($c.releaseBaseUrl.TrimEnd('/'))/$($c.releaseVersion)"; $releaseHeaders=Get-ReleaseHeader -Config $c
    foreach($name in @('release-manifest.json','release-manifest.json.sig','release-manifest.json.pem')){Invoke-WebRequest "$base/$name" -Headers $releaseHeaders -OutFile (Join-Path $stage $name)}
    $manifest=Test-ReleaseManifest -Config $c -Stage $stage; $bundle=$manifest.bundles.E2E_WINDOWS.file
    if($bundle -ne 'E2E_WINDOWS.zip'){throw 'Windows release bundle metadata is invalid'}
    Invoke-WebRequest "$base/$bundle" -Headers $releaseHeaders -OutFile (Join-Path $stage $bundle)
    $actual=(Get-FileHash -Algorithm SHA256 (Join-Path $stage $bundle)).Hash.ToLowerInvariant()
    if($actual -ne $manifest.bundles.E2E_WINDOWS.sha256){throw 'Windows release bundle checksum mismatch'}
    Test-GoldenVm -Config $c -Manifest $manifest
    $goldenDirectory=Join-Path $State 'golden'; New-Item -ItemType Directory -Force $goldenDirectory | Out-Null; Set-RestrictedAcl -Path $goldenDirectory
    $goldenVmFile=Join-Path $goldenDirectory (Split-Path -Leaf $c.goldenVmFile)
    Copy-Item -LiteralPath $c.goldenVmFile -Destination $goldenVmFile -Force
    Copy-Item -LiteralPath "$($c.goldenVmFile).pem" -Destination "$goldenVmFile.pem" -Force
    Copy-Item -LiteralPath "$($c.goldenVmFile).sig" -Destination "$goldenVmFile.sig" -Force
    $release=Join-Path $Root "releases\$($c.releaseVersion)"
    if(!(Test-Path $release)){New-Item -ItemType Directory -Force $release | Out-Null; Expand-Archive (Join-Path $stage $bundle) -DestinationPath $release; Copy-Item "$stage\release-manifest.json*" $release}
    $nodeId=Initialize-Enrollment -Config $c -Release $release
    $oldTarget=$null; $current=Join-Path $Root 'current'; if(Test-Path $current){$oldTarget=(Get-Item $current).Target; Stop-Service $Service -ErrorAction SilentlyContinue; Remove-Item $current -Force}
    try { New-Item -ItemType Junction -Path $current -Target $release | Out-Null; Set-ServiceConfiguration -Config $c -NodeId $nodeId -GoldenVmFile $goldenVmFile; Start-Service $Service; Start-Sleep -Seconds 3; if((Get-Service $Service).Status -ne 'Running'){throw 'E2E service did not stay running'} }
    catch { Remove-Item $current -Force -ErrorAction SilentlyContinue; if($oldTarget){New-Item -ItemType Junction -Path $current -Target $oldTarget | Out-Null; Start-Service $Service -ErrorAction SilentlyContinue}; throw }
  } finally { if($mutex){$mutex.ReleaseMutex();$mutex.Dispose()} }
}
function Invoke-Rollback {
  $c=Read-Config; if(!$c.rollbackVersion){throw 'rollbackVersion is required'}
  $target=Join-Path $Root "releases\$($c.rollbackVersion)"; Test-RequiredFile -Path "$target\release-manifest.json"
  $active=Get-Content "$Root\current\release-manifest.json" -Raw | ConvertFrom-Json; $candidate=Get-Content "$target\release-manifest.json" -Raw | ConvertFrom-Json
  if($active.database.schemaCompatibility -ne $candidate.database.schemaCompatibility){throw 'Rollback schema compatibility differs'}
  Stop-Service $Service; Remove-Item "$Root\current" -Force; New-Item -ItemType Junction -Path "$Root\current" -Target $target | Out-Null; Start-Service $Service
}
switch($Action){'preflight'{Invoke-Preflight};'bootstrap'{Invoke-Bootstrap};'deploy'{Invoke-Deploy};'status'{Get-Service $Service};'rollback'{Invoke-Rollback}}
