param([string]$Action,[string]$Stage,[string]$JobId,[string]$WorkspaceId,[long]$Generation,[string]$RuntimeImage)
$ErrorActionPreference='Stop'
if($JobId -notmatch '^[0-9a-f-]{36}$' -or $WorkspaceId -notmatch '^[0-9a-f-]{36}$' -or $Generation -lt 1 -or $RuntimeImage -notmatch '^sha256:[0-9a-f]{64}$'){throw 'Invalid isolation request'}
$vm="deviludo-$JobId"
if($Action -eq 'reimage' -and $Stage -eq 'before'){
  $digest='sha256:'+((Get-FileHash -Algorithm SHA256 -LiteralPath $env:DEVILUDO_GOLDEN_VM_FILE).Hash.ToLowerInvariant())
  if($digest -ne $RuntimeImage){throw 'Golden VM digest does not match the leased runtime'}
  & cosign verify-blob --certificate "$env:DEVILUDO_GOLDEN_VM_FILE.pem" --signature "$env:DEVILUDO_GOLDEN_VM_FILE.sig" --certificate-identity-regexp $env:DEVILUDO_COSIGN_IDENTITY_REGEXP --certificate-oidc-issuer $env:DEVILUDO_COSIGN_ISSUER $env:DEVILUDO_GOLDEN_VM_FILE | Out-Null
  Import-VM -Path $env:DEVILUDO_GOLDEN_VM_FILE -Copy -GenerateNewId -VirtualMachinePath "C:\ProgramData\Deviludo\jobs\$JobId" | Rename-VM -NewName $vm
  Start-VM $vm
} elseif(($Action -eq 'cleanup' -or $Action -eq 'reimage') -and $Stage -eq 'after'){
  Stop-VM $vm -TurnOff -Force -ErrorAction SilentlyContinue
  Remove-VM $vm -Force -ErrorAction SilentlyContinue
  Remove-Item "C:\ProgramData\Deviludo\jobs\$JobId" -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem 'C:\ProgramData\Deviludo\jobs' -Directory -Filter "deviludo-$JobId-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
} else { throw 'Invalid isolation transition' }
"$Action`:$Stage`:$JobId`:g$Generation`:hyperv"
