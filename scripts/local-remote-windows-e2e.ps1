param(
  [Parameter(Mandatory=$true)][ValidateSet('enroll','run','status')][string]$Action,
  [string]$CoreUrl,
  [string]$EnrollmentTokenFile,
  [string]$GoldenVmArchive,
  [string]$GuestCredentialFile,
  [string]$RepositoryPath=(Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference='Stop'
$State='C:\ProgramData\DeviludoRemoteE2E'
$Credentials=Join-Path $State 'credentials'
$Jobs=Join-Path $State 'jobs'
$Golden=Join-Path $State 'golden'

function Assert-Administrator {
  $principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run PowerShell as Administrator'}
}
function Assert-File([string]$Path,[string]$Label){if(!$Path -or !(Test-Path -LiteralPath $Path -PathType Leaf)){throw "$Label is missing: $Path"}}
function Node-Executable {
  $node=(Get-Command node.exe -ErrorAction Stop).Source
  $version=(& $node --version).Trim()
  if($version -notmatch '^v(2[2-9]|[3-9][0-9])\.'){throw 'Node.js 22 or later is required'}
  return $node
}
function Assert-Repository {
  Assert-File (Join-Path $RepositoryPath 'services\e2e-node\src\main.ts') 'E2E node source'
  Assert-File (Join-Path $RepositoryPath 'deploy\assets\e2e-job-executor.mjs') 'E2E executor'
  Assert-File (Join-Path $RepositoryPath 'deploy\assets\e2e-windows-isolation.ps1') 'Windows isolation driver'
  Assert-File (Join-Path $RepositoryPath 'deploy\assets\e2e-windows-guest-runner.ps1') 'Windows guest driver'
  if(!(Test-Path -LiteralPath (Join-Path $RepositoryPath 'node_modules\tsx'))){throw 'Run npm ci in the DeviLudo checkout first'}
}
function Write-Wrapper([string]$Path,[string]$Script){
  $escaped=$Script.Replace('%','%%')
  "@echo off`r`npowershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$escaped`" %*`r`n" | Set-Content -LiteralPath $Path -Encoding ASCII
}
function Resolve-GoldenConfiguration {
  $matches=@(Get-ChildItem -LiteralPath $Golden -Recurse -File -Filter '*.vmcx')
  if($matches.Count -ne 1){throw "Golden VM archive must contain exactly one .vmcx file; found $($matches.Count)"}
  return $matches[0].FullName
}
function Invoke-Enroll {
  Assert-Administrator; Assert-Repository
  Assert-File $EnrollmentTokenFile 'Enrollment token file'
  Assert-File $GoldenVmArchive 'Golden VM ZIP archive'
  Assert-File $GuestCredentialFile 'PowerShell Direct guest credential'
  if(!$CoreUrl){throw 'CoreUrl is required'}
  if([IO.Path]::GetExtension($GoldenVmArchive) -ne '.zip'){throw 'GoldenVmArchive must be a ZIP of an exported Hyper-V VM'}
  $feature=Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
  if($feature.State -ne 'Enabled'){throw 'Enable Hyper-V and restart Windows before enrollment'}
  $node=Node-Executable
  New-Item -ItemType Directory -Force $State,$Credentials,$Jobs,$Golden | Out-Null
  & icacls.exe $State '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Failed to restrict the remote E2E state directory'}
  & $node (Join-Path $RepositoryPath 'scripts\remote-e2e-enroll.mjs') `
    --platform windows --core-url $CoreUrl --enrollment-token-file $EnrollmentTokenFile `
    --runtime-image-file $GoldenVmArchive --credential-directory $Credentials
  if($LASTEXITCODE -ne 0){throw 'Development E2E enrollment failed'}
  Get-ChildItem -LiteralPath $Golden -Force | Remove-Item -Recurse -Force
  Expand-Archive -LiteralPath $GoldenVmArchive -DestinationPath $Golden -Force
  [void](Resolve-GoldenConfiguration)
  Copy-Item -LiteralPath $GuestCredentialFile -Destination (Join-Path $State 'guest-credential.xml') -Force
  Write-Wrapper (Join-Path $State 'isolation.cmd') (Join-Path $RepositoryPath 'deploy\assets\e2e-windows-isolation.ps1')
  Write-Wrapper (Join-Path $State 'guest-runner.cmd') (Join-Path $RepositoryPath 'deploy\assets\e2e-windows-guest-runner.ps1')
  Write-Output "Enrolled. Run: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action run -RepositoryPath `"$RepositoryPath`""
}
function Invoke-Run {
  Assert-Administrator; Assert-Repository
  $node=Node-Executable
  $configurationFile=Join-Path $Credentials 'node.json'
  Assert-File $configurationFile 'Enrolled node configuration'
  $configuration=Get-Content -LiteralPath $configurationFile -Raw | ConvertFrom-Json
  $goldenConfiguration=Resolve-GoldenConfiguration
  $env:NODE_ENV='development'
  $env:DEVILUDO_E2E_NODE_ID=$configuration.nodeId
  $env:DEVILUDO_E2E_POOL_KIND='E2E_WINDOWS'
  $env:DEVILUDO_CORE_API_URL=$configuration.coreUrl
  $env:DEVILUDO_E2E_NODE_TOKEN=$configuration.token
  $env:DEVILUDO_E2E_IDENTITY_KEY_FILE=$configuration.identityKeyFile
  $env:DEVILUDO_E2E_TOOL_PATH="C:\Program Files\nodejs;C:\Program Files\cosign;C:\Windows\System32;C:\Windows"
  $env:DEVILUDO_E2E_JOB_ROOT=$Jobs
  $env:DEVILUDO_E2E_GUEST_CREDENTIAL_FILE=(Join-Path $State 'guest-credential.xml')
  $env:DEVILUDO_E2E_ISOLATION_EXECUTOR=(Join-Path $State 'isolation.cmd')
  $env:DEVILUDO_E2E_TEST_EXECUTOR=(Join-Path $RepositoryPath 'deploy\assets\e2e-job-executor.mjs')
  $env:DEVILUDO_E2E_GUEST_RUNNER=(Join-Path $State 'guest-runner.cmd')
  $env:DEVILUDO_GOLDEN_VM_ARCHIVE=$configuration.runtimeImageFile
  $env:DEVILUDO_GOLDEN_VM_FILE=$goldenConfiguration
  $env:DEVILUDO_E2E_ALLOW_UNSIGNED_LOCAL_RUNTIME='1'
  Push-Location $RepositoryPath
  try { & $node --import tsx services/e2e-node/src/main.ts }
  finally { Pop-Location }
}
function Invoke-Status {
  $configurationFile=Join-Path $Credentials 'node.json'
  Assert-File $configurationFile 'Enrolled node configuration'
  $configuration=Get-Content -LiteralPath $configurationFile -Raw | ConvertFrom-Json
  $target=[Uri]$configuration.coreUrl
  $connection=Test-NetConnection -ComputerName $target.Host -Port $target.Port -WarningAction SilentlyContinue
  [pscustomobject]@{nodeId=$configuration.nodeId;poolKind=$configuration.poolKind;coreUrl=$configuration.coreUrl;reachable=$connection.TcpTestSucceeded;goldenVm=(Resolve-GoldenConfiguration)}
}

switch($Action){'enroll'{Invoke-Enroll};'run'{Invoke-Run};'status'{Invoke-Status}}
