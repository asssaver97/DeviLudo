BeforeAll {
  $ScriptPath = Join-Path $PSScriptRoot '..\e2e-windows\deploy.ps1'
  $IsolationPath = Join-Path $PSScriptRoot '..\assets\e2e-windows-isolation.ps1'
  $Script = Get-Content -LiteralPath $ScriptPath -Raw
  $Isolation = Get-Content -LiteralPath $IsolationPath -Raw
}

Describe 'Windows E2E deployment contract' {
  It 'parses as PowerShell' {
    { [scriptblock]::Create($Script) } | Should -Not -Throw
    { [scriptblock]::Create($Isolation) } | Should -Not -Throw
  }

  It 'exposes every local deployment action' {
    $Script | Should -Match "ValidateSet\('preflight','bootstrap','deploy','status','rollback'\)"
  }

  It 'requires fixed package versions and signed release inputs' {
    $Script | Should -Match 'packageVersions'
    $Script | Should -Match 'winget install --id \$package.Id --version \$package.Version'
    $Script | Should -Match 'cosign verify-blob'
    $Script | Should -Match 'Get-FileHash -Algorithm SHA256'
    $Script | Should -Match 'releaseAuthHeaderFile'
  }

  It 'uses a global deployment mutex and schema-compatible rollback' {
    $Script | Should -Match "Global\\DeviludoDeploy"
    $Script | Should -Match 'schemaCompatibility'
  }

  It 'destroys the Hyper-V guest and transient job directories' {
    $Isolation | Should -Match 'Remove-VM \$vm -Force'
    $Isolation | Should -Match 'Filter "deviludo-\$JobId-\*"'
  }
}
