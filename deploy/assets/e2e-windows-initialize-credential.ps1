param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
$input=Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
if([string]::IsNullOrWhiteSpace($input.username) -or [string]::IsNullOrWhiteSpace($input.password)){throw 'Guest credential bootstrap JSON is invalid'}
$secure=ConvertTo-SecureString ([string]$input.password) -AsPlainText -Force
$credential=[Management.Automation.PSCredential]::new([string]$input.username,$secure)
$credential | Export-Clixml -LiteralPath $OutputFile -Force
