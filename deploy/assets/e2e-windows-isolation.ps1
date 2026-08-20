param([string]$Action,[string]$Stage,[string]$JobId,[string]$WorkspaceId,[long]$Generation,[string]$RuntimeImage)
$ErrorActionPreference='Stop'
$jobRoot=$(if($env:DEVILUDO_E2E_JOB_ROOT){$env:DEVILUDO_E2E_JOB_ROOT}else{'C:\ProgramData\Deviludo\jobs'})
if($Action -eq 'reap'){
  $removed=0
  Get-ChildItem $jobRoot -Directory -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '^[0-9a-f-]{36}$'} | ForEach-Object {
    $vm="deviludo-$($_.Name)"
    Stop-VM $vm -TurnOff -Force -ErrorAction SilentlyContinue
    Remove-VM $vm -Force -ErrorAction SilentlyContinue
    if(Get-VM $vm -ErrorAction SilentlyContinue){throw "Failed to reap Hyper-V VM $vm"}
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem $jobRoot -Directory -Filter "deviludo-$($_.Name)-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    $removed++
  }
  "reap:$removed"
  exit 0
}
if($JobId -notmatch '^[0-9a-f-]{36}$' -or $WorkspaceId -notmatch '^[0-9a-f-]{36}$' -or $Generation -lt 1 -or $RuntimeImage -notmatch '^sha256:[0-9a-f]{64}$'){throw 'Invalid isolation request'}
$vm="deviludo-$JobId"
$jobDirectory=Join-Path $jobRoot $JobId
if($Action -eq 'reimage' -and $Stage -eq 'before'){
  if(!(Test-Path -LiteralPath $env:DEVILUDO_GOLDEN_VM_ARCHIVE -PathType Leaf) -or !(Test-Path -LiteralPath $env:DEVILUDO_GOLDEN_VM_FILE -PathType Leaf)){throw 'Golden VM archive or configuration is missing'}
  $digest='sha256:'+((Get-FileHash -Algorithm SHA256 -LiteralPath $env:DEVILUDO_GOLDEN_VM_ARCHIVE).Hash.ToLowerInvariant())
  if($digest -ne $RuntimeImage){throw 'Golden VM digest does not match the leased runtime'}
  if($env:NODE_ENV -eq 'production' -or $env:DEVILUDO_E2E_ALLOW_UNSIGNED_LOCAL_RUNTIME -ne '1'){
    & cosign verify-blob --certificate "$env:DEVILUDO_GOLDEN_VM_ARCHIVE.pem" --signature "$env:DEVILUDO_GOLDEN_VM_ARCHIVE.sig" --certificate-identity-regexp $env:DEVILUDO_COSIGN_IDENTITY_REGEXP --certificate-oidc-issuer $env:DEVILUDO_COSIGN_ISSUER $env:DEVILUDO_GOLDEN_VM_ARCHIVE | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Golden VM signature validation failed'}
  }
  New-Item -ItemType Directory -Force $jobDirectory,(Join-Path $jobDirectory 'Virtual Hard Disks'),(Join-Path $jobDirectory 'Snapshots') | Out-Null
  Import-VM -Path $env:DEVILUDO_GOLDEN_VM_FILE -Copy -GenerateNewId -VirtualMachinePath $jobDirectory -VhdDestinationPath (Join-Path $jobDirectory 'Virtual Hard Disks') -SnapshotFilePath (Join-Path $jobDirectory 'Snapshots') | Rename-VM -NewName $vm
  Start-VM $vm
} elseif(($Action -eq 'cleanup' -or $Action -eq 'reimage') -and $Stage -eq 'after'){
  if(Get-VM $vm -ErrorAction SilentlyContinue){
    Stop-VM $vm -TurnOff -Force -ErrorAction SilentlyContinue
    Remove-VM $vm -Force -ErrorAction SilentlyContinue
    if(Get-VM $vm -ErrorAction SilentlyContinue){throw "Failed to remove Hyper-V VM $vm"}
  }
  Remove-Item $jobDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem $jobRoot -Directory -Filter "deviludo-$JobId-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
} else { throw 'Invalid isolation transition' }
"$Action`:$Stage`:$JobId`:g$Generation`:hyperv"
