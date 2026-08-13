param([Parameter(Position=0)][ValidateSet('test','clean-install')][string]$Action,[string]$JobId,[string]$Artifact)
$ErrorActionPreference='Stop'
if($JobId -notmatch '^[0-9a-f-]{36}$' -or !(Test-Path -LiteralPath $Artifact)){throw 'Invalid guest execution request'}
$vm="deviludo-$JobId"
$credential=Import-Clixml 'C:\ProgramData\Deviludo\guest-credential.xml'
$destination='C:\Deviludo\input\artifact'
$session=New-PSSession -VMName $vm -Credential $credential
try {
  Copy-Item -LiteralPath $Artifact -Destination $destination -ToSession $session -Force
  $receiptJson=Invoke-Command -Session $session -ScriptBlock { param($a,$p,$j) & 'C:\Program Files\Deviludo\guest-runner.exe' $a $p '--job-id' $j '--json' } -ArgumentList $Action,$destination,$JobId
  $receipt=($receiptJson|Out-String)|ConvertFrom-Json
  if($Action -eq 'test'){
    if([string]::IsNullOrWhiteSpace($env:DEVILUDO_E2E_HOST_OUTPUT)){throw 'Host evidence output is required'}
    if($receipt.outputPath -notlike 'C:\Deviludo\*'){throw 'Guest evidence path escaped the guest job directory'}
    Copy-Item -LiteralPath $receipt.outputPath -Destination $env:DEVILUDO_E2E_HOST_OUTPUT -FromSession $session -Force
    $receipt.outputPath=$env:DEVILUDO_E2E_HOST_OUTPUT
  }
  $receipt|ConvertTo-Json -Compress -Depth 20
} finally {
  Remove-PSSession $session -ErrorAction SilentlyContinue
}
