param([Parameter(Position=0)][ValidateSet('test','clean-install')][string]$Action,[string]$JobId,[string]$Artifact)
$ErrorActionPreference='Stop'
if($JobId -notmatch '^[0-9a-f-]{36}$' -or !(Test-Path -LiteralPath $Artifact)){throw 'Invalid guest execution request'}
$vm="deviludo-$JobId"
$credential=Import-Clixml 'C:\ProgramData\Deviludo\guest-credential.xml'
$destination='C:\Deviludo\input\artifact'
Copy-VMFile -VMName $vm -SourcePath $Artifact -DestinationPath $destination -FileSource Host -CreateFullPath -Force
$receipt=Invoke-Command -VMName $vm -Credential $credential -ScriptBlock { param($a,$p) & 'C:\Program Files\Deviludo\guest-runner.exe' $a $p '--json' } -ArgumentList $Action,$destination
$receipt | Out-String
