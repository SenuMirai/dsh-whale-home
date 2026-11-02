param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
  & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  Write-Output 'MSVC is installed. Run wechat.ps1 Build.'
  exit 0
}

if ($CheckOnly) {
  Write-Output 'MSVC / vswhere.exe not found.'
  exit 1
}

Write-Output 'Installing Visual Studio 2022 Build Tools with the C++ x64 workload (several GB, may take a while).'
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact `
  --accept-package-agreements --accept-source-agreements `
  --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
if ($LASTEXITCODE -ne 0) { throw "Build Tools install failed: winget exit $LASTEXITCODE" }

if (-not (Test-Path -LiteralPath $vswhere)) { throw 'vswhere.exe is still missing; reboot and retry.' }
& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
Write-Output 'Done. Now run wechat.ps1 Build.'
