$ErrorActionPreference='Stop'
$config=Get-Content 'C:\ProgramData\Deviludo\node.json' -Raw | ConvertFrom-Json
$env:DEVILUDO_CORE_API_URL=$config.coreUrl
$env:DEVILUDO_E2E_CREDENTIAL_DIRECTORY=$config.credentialDirectory
& 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\Deviludo\current\e2e-renew.mjs'
if($LASTEXITCODE -ne 0){throw 'E2E certificate renewal failed'}
