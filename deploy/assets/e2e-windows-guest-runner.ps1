param(
  [Parameter(Position=0)][ValidateSet('test')][string]$Action,
  [Alias('job-id')][string]$JobId,
  [string]$Artifact,
  [Alias('test-plan')][string]$TestPlan,
  [string]$Regression
)
$ErrorActionPreference='Stop'
if($JobId -notmatch '^[0-9a-f-]{36}$' -or !(Test-Path -LiteralPath $Artifact) -or !(Test-Path -LiteralPath $TestPlan)){throw 'Invalid guest execution request'}
if($Regression -and !(Test-Path -LiteralPath $Regression)){throw 'Current regression input does not exist'}
$vm="deviludo-$JobId"
$credentialFile=$(if($env:DEVILUDO_E2E_GUEST_CREDENTIAL_FILE){$env:DEVILUDO_E2E_GUEST_CREDENTIAL_FILE}else{'C:\ProgramData\Deviludo\guest-credential.xml'})
if(!(Test-Path -LiteralPath $credentialFile -PathType Leaf)){throw 'PowerShell Direct guest credential is missing'}
$credential=Import-Clixml $credentialFile
$destination='C:\Deviludo\input\artifact'
$testPlanDestination='C:\Deviludo\input\test-plan.json'
$regressionDestination='C:\Deviludo\input\regression.json'
$projectId=$(if($env:DEVILUDO_E2E_PROJECT_ID){$env:DEVILUDO_E2E_PROJECT_ID}else{$JobId})
$frozenTimeout=$env:DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS
$contractDigest=$env:DEVILUDO_E2E_CONTRACT_DIGEST
$session=New-PSSession -VMName $vm -Credential $credential
try {
  Copy-Item -LiteralPath $Artifact -Destination $destination -ToSession $session -Force
  Copy-Item -LiteralPath $TestPlan -Destination $testPlanDestination -ToSession $session -Force
  if($Regression){Copy-Item -LiteralPath $Regression -Destination $regressionDestination -ToSession $session -Force}
  Invoke-Command -Session $session -ScriptBlock {
    param($a,$p,$j,$testPlan,$r,$projectId,$frozenTimeout,$contractDigest)
    $psi=New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName='C:\Program Files\Deviludo\guest-runner.exe'
    $psi.Arguments="$a $p --job-id $j --test-plan $testPlan --json" + $(if($r){" --regression $r"}else{''})
    $psi.UseShellExecute=$false
    $psi.RedirectStandardInput=$true
    $psi.RedirectStandardOutput=$true
    $psi.RedirectStandardError=$true
    $psi.CreateNoWindow=$true
    $psi.EnvironmentVariables['DEVILUDO_GUI_DRIVER']='C:\Program Files\Deviludo\gui-driver.exe'
    $psi.EnvironmentVariables['DEVILUDO_GAMEPAD_DRIVER']='C:\Program Files\Deviludo\vhf-gamepad-driver.exe'
    $psi.EnvironmentVariables['DEVILUDO_GUEST_EVIDENCE_ROOT']='C:\Deviludo\output'
    $psi.EnvironmentVariables['DEVILUDO_GUEST_JOB_ROOT']='C:\Deviludo\jobs'
    $psi.EnvironmentVariables['DEVILUDO_E2E_STREAM_PROTOCOL']='1'
    $psi.EnvironmentVariables['DEVILUDO_E2E_PROJECT_ID']=$projectId
    $psi.EnvironmentVariables['DEVILUDO_E2E_FROZEN_TIMEOUT_SECONDS']=$frozenTimeout
    $psi.EnvironmentVariables['DEVILUDO_E2E_CONTRACT_DIGEST']=$contractDigest
    $global:DeviludoE2EProcess=New-Object System.Diagnostics.Process
    $global:DeviludoE2EProcess.StartInfo=$psi
    if(!$global:DeviludoE2EProcess.Start()){throw 'Failed to start the guest runner'}
  } -ArgumentList $Action,$destination,$JobId,$testPlanDestination,$(if($Regression){$regressionDestination}else{''}),$projectId,$frozenTimeout,$contractDigest | Out-Null
  $receipt=$null
  while($true){
    $line=Invoke-Command -Session $session -ScriptBlock {
      if($global:DeviludoE2EProcess.StandardOutput.EndOfStream){return $null}
      return $global:DeviludoE2EProcess.StandardOutput.ReadLine()
    }
    if($null -eq $line){break}
    $message=($line|Out-String).Trim()|ConvertFrom-Json
    if($message.type -eq 'policy_request'){
      [Console]::Out.WriteLine(($message|ConvertTo-Json -Compress -Depth 30))
      [Console]::Out.Flush()
      $response=[Console]::In.ReadLine()
      if([string]::IsNullOrWhiteSpace($response)){throw 'Player policy relay closed'}
      $parsed=$response|ConvertFrom-Json
      if($parsed.type -ne 'policy_response' -or $parsed.id -ne $message.id){throw 'Player policy relay response is invalid'}
      Invoke-Command -Session $session -ScriptBlock {param($json) $global:DeviludoE2EProcess.StandardInput.WriteLine($json); $global:DeviludoE2EProcess.StandardInput.Flush()} -ArgumentList $response
    } elseif($message.type -eq 'result'){$receipt=$message.value}
    else {throw 'Guest emitted an unknown frame'}
  }
  $exitCode=Invoke-Command -Session $session -ScriptBlock {
    $global:DeviludoE2EProcess.WaitForExit()
    return $global:DeviludoE2EProcess.ExitCode
  }
  if($exitCode -ne 0 -or $null -eq $receipt){
    $diagnostic=Invoke-Command -Session $session -ScriptBlock {$global:DeviludoE2EProcess.StandardError.ReadToEnd()}
    throw "Guest runner failed: $diagnostic"
  }
  if([string]::IsNullOrWhiteSpace($env:DEVILUDO_E2E_HOST_OUTPUT)){throw 'Host evidence output is required'}
  if($receipt.outputPath -notlike 'C:\Deviludo\*'){throw 'Guest evidence path escaped the guest job directory'}
  Copy-Item -LiteralPath $receipt.outputPath -Destination $env:DEVILUDO_E2E_HOST_OUTPUT -FromSession $session -Force
  $receipt.outputPath=$env:DEVILUDO_E2E_HOST_OUTPUT
  if($receipt.regressionOutputPath){
    if([string]::IsNullOrWhiteSpace($env:DEVILUDO_E2E_HOST_REGRESSION_OUTPUT)){throw 'Host regression output is required'}
    if($receipt.regressionOutputPath -notlike 'C:\Deviludo\*'){throw 'Guest regression path escaped the guest job directory'}
    Copy-Item -LiteralPath $receipt.regressionOutputPath -Destination $env:DEVILUDO_E2E_HOST_REGRESSION_OUTPUT -FromSession $session -Force
    $receipt.regressionOutputPath=$env:DEVILUDO_E2E_HOST_REGRESSION_OUTPUT
  }
  @{type='result';value=$receipt}|ConvertTo-Json -Compress -Depth 30
} finally {
  Remove-PSSession $session -ErrorAction SilentlyContinue
}
